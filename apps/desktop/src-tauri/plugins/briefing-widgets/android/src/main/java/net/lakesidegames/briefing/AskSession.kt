package net.lakesidegames.briefing

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicInteger

internal enum class AskPhase { CHECKING, SIGNED_OUT, UNAVAILABLE, CONSENT, READY }

/** What the sheet listens to. Always called on the main thread. */
internal interface AskSessionListener {
  /** Phase, account, quota, composer or banner state changed. */
  fun onChrome()
  /** Messages were added, removed or replaced. */
  fun onThread()
  /** One message changed in place (streaming text, status, feedback). */
  fun onMessage(message: AskMessage)
  fun onHistory()
  fun onAttachments()
  fun onSnack(text: String, action: String? = null, onAction: (() -> Unit)? = null)
  fun onShareLink(url: String)
}

/**
 * Ask's state for this process: account, consent, the open chat, the draft,
 * attachments and history. It outlives the sheet, so closing and reopening
 * Ask (or a rotation that rebuilds the sheet) picks up exactly where the
 * player left off, including an answer that is still streaming.
 */
internal class AskSession(context: Context, cookies: Map<String, String>, val preview: Boolean) {
  private val appContext = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val worker: ExecutorService = Executors.newFixedThreadPool(3, object : ThreadFactory {
    private val count = AtomicInteger()
    override fun newThread(task: Runnable) = Thread(task, "ask-${count.incrementAndGet()}").apply { isDaemon = true }
  })
  private var api = NativeAskApi(cookies)
  private var nextLocalId = 1L
  private var listener: AskSessionListener? = null
  private var pendingMessageFlush: Runnable? = null
  private val dirtyMessages = LinkedHashSet<AskMessage>()
  private var lastFlush = 0L
  private val uploadCache = android.util.LruCache<String, Bitmap>(12)
  private val mapCache = android.util.LruCache<String, String>(8)

  var phase = AskPhase.CHECKING; private set
  var checking = false; private set
  var unavailableMessage = ""; private set
  var profileName = ""; private set
  var usage: AskUsage? = null; private set
  var recipients: List<Pair<String, String>> = emptyList(); private set
  var consented = false; private set
  var reviewingConsent = false
  var linkError = ""; private set

  val messages = mutableListOf<AskMessage>()
  var conversationID = ""; private set
  var loadingConversation = false; private set
  var followupsLeft: Int? = null; private set
  var draft = ""
  val attachments = mutableListOf<AskAttachment>()
  var showingHistory = false
  var history: List<AskConversationSummary> = emptyList(); private set
  var historyLoaded = false; private set
  var historyLoading = false; private set
  var historyError = ""; private set
  private val pendingDeletes = linkedMapOf<String, AskConversationSummary>()

  private var activeMessage: AskMessage? = null
  private var activeReqId = ""
  private var stopRequested = false

  val sending: Boolean get() = activeMessage != null
  val uploading: Boolean get() = attachments.any { it.uploading }
  val signedIn: Boolean get() = phase == AskPhase.READY || phase == AskPhase.CONSENT

  fun attach(listener: AskSessionListener?) {
    this.listener = listener
  }

  fun detach(listener: AskSessionListener) {
    if (this.listener === listener) this.listener = null
  }

  /** A newer cookie snapshot (after linking) replaces the client while signed out. */
  fun refreshCookies(snapshot: Map<String, String>) {
    if (!signedIn && !checking && !preview) api = NativeAskApi(snapshot)
  }

  // ---- Lifecycle ---------------------------------------------------------

  /** Called whenever the sheet appears. Cheap when nothing needs refreshing. */
  fun onSheetShown() {
    if (preview) return
    when (phase) {
      AskPhase.CHECKING, AskPhase.SIGNED_OUT, AskPhase.UNAVAILABLE -> connect()
      AskPhase.CONSENT -> Unit
      AskPhase.READY -> {
        refreshQuota()
        loadHistory(silent = true)
      }
    }
  }

  fun connect() {
    if (checking || preview) return
    checking = true
    if (phase != AskPhase.READY && phase != AskPhase.CONSENT) phase = AskPhase.CHECKING
    linkError = ""
    chrome()
    submit("Ask session") {
      try {
        val profile = api.connect()
        val listed = NativeAskConsent.recipients(profile)
        post("Ask session success") {
          checking = false
          recipients = listed
          profileName = profileNameOf(profile)
          usage = AskUsage.from(profile) ?: usage
          consented = NativeAskConsent.granted(appContext, listed)
          phase = if (consented) AskPhase.READY else AskPhase.CONSENT
          chrome()
          if (phase == AskPhase.READY) afterReady()
        }
      } catch (failure: Exception) {
        post("Ask session failure") {
          checking = false
          if (failure is NativeAskAuthRequired) {
            phase = AskPhase.SIGNED_OUT
            linkError = ""
          } else {
            phase = AskPhase.UNAVAILABLE
            unavailableMessage = if (!online()) T.s(R.string.ask_offline_ready)
              else askPlayerMessage(failure)
          }
          chrome()
        }
      }
    }
  }

  private fun afterReady() {
    loadHistory(silent = historyLoaded)
    if (conversationID.isNotBlank() && messages.isEmpty() && !loadingConversation) openConversation(conversationID)
  }

  fun grantConsent() {
    NativeAskConsent.grant(appContext, recipients)
    consented = true
    reviewingConsent = false
    if (phase == AskPhase.CONSENT) phase = AskPhase.READY
    chrome()
    afterReady()
  }

  fun withdrawConsent() {
    NativeAskConsent.withdraw(appContext)
    consented = false
    reviewingConsent = false
    phase = AskPhase.CONSENT
    chrome()
  }

  fun refreshQuota() {
    if (preview || !signedIn) return
    submit("Ask quota") {
      try {
        val profile = api.me()
        post("Ask quota UI") {
          usage = AskUsage.from(profile) ?: usage
          val listed = NativeAskConsent.recipients(profile)
          if (NativeAskConsent.signature(listed) != NativeAskConsent.signature(recipients)) {
            recipients = listed
            consented = NativeAskConsent.granted(appContext, listed)
            if (!consented) phase = AskPhase.CONSENT
          }
          chrome()
        }
      } catch (failure: Exception) {
        if (failure is NativeAskAuthRequired) post("Ask signed out") { signOutLocally() }
      }
    }
  }

  private fun signOutLocally() {
    phase = AskPhase.SIGNED_OUT
    usage = null
    profileName = ""
    history = emptyList()
    historyLoaded = false
    chrome()
    listener?.onHistory()
  }

  // ---- History -----------------------------------------------------------

  fun loadHistory(silent: Boolean = false) {
    if (preview || historyLoading || !signedIn) return
    historyLoading = true
    if (!silent) historyError = ""
    listener?.onHistory()
    submit("Ask history") {
      try {
        val result = api.conversations()
        val list = AskConversationSummary.list(result)
        val quota = AskUsage.from(result)
        post("Ask history UI") {
          historyLoading = false
          historyLoaded = true
          historyError = ""
          history = list.filter { it.id !in pendingDeletes }
          if (quota != null) usage = quota
          listener?.onHistory()
          chrome()
        }
      } catch (failure: Exception) {
        post("Ask history failure") {
          historyLoading = false
          if (failure is NativeAskAuthRequired) { signOutLocally(); return@post }
          if (!silent || !historyLoaded) historyError = askPlayerMessage(failure)
          listener?.onHistory()
        }
      }
    }
  }

  /** Hide now, delete for real when the undo window closes. */
  fun deleteLater(item: AskConversationSummary) {
    pendingDeletes[item.id] = item
    history = history.filter { it.id != item.id }
    listener?.onHistory()
    if (item.id == conversationID && !sending) newChat()
  }

  fun undoDelete(id: String) {
    val item = pendingDeletes.remove(id) ?: return
    history = (history + item).sortedWith(compareByDescending<AskConversationSummary> { it.pinned }.thenByDescending { it.updated })
    listener?.onHistory()
  }

  fun commitDelete(id: String) {
    val item = pendingDeletes.remove(id) ?: return
    if (preview) return
    submit("Ask delete") {
      try {
        api.deleteConversation(id)
      } catch (failure: Exception) {
        post("Ask delete failure") {
          history = (history + item).sortedByDescending { it.updated }
          listener?.onHistory()
          listener?.onSnack(T.s(R.string.ask_snack_delete_failed, askPlayerMessage(failure)))
        }
      }
    }
  }

  /** Deletions still inside their undo window go through when the sheet closes. */
  fun commitPendingDeletes() {
    pendingDeletes.keys.toList().forEach(::commitDelete)
  }

  // ---- Conversation ------------------------------------------------------

  fun newChat() {
    if (sending) return
    conversationID = ""
    messages.clear()
    followupsLeft = null
    loadingConversation = false
    showingHistory = false
    listener?.onThread()
    chrome()
  }

  fun openConversation(id: String) {
    if (sending) {
      listener?.onSnack(T.s(R.string.ask_snack_wait_answer))
      return
    }
    showingHistory = false
    if (id == conversationID && messages.isNotEmpty()) { chrome(); listener?.onThread(); return }
    conversationID = id
    messages.clear()
    followupsLeft = null
    loadingConversation = true
    listener?.onThread()
    chrome()
    if (preview) { loadingConversation = false; AskPreview.fillConversation(this, id); return }
    submit("Ask conversation") {
      try {
        val result = api.conversation(id)
        val turns = result.optJSONArray("turns")
        post("Ask conversation UI") {
          if (conversationID != id) return@post
          loadingConversation = false
          messages.clear()
          if (turns != null) for (index in 0 until turns.length()) {
            turns.optJSONObject(index)?.let { AskMessage.fromTurn(nextLocalId++, it) }?.let(messages::add)
          }
          listener?.onThread()
          chrome()
        }
      } catch (failure: Exception) {
        post("Ask conversation failure") {
          if (conversationID != id) return@post
          loadingConversation = false
          if (failure is NativeAskAuthRequired) { signOutLocally(); return@post }
          conversationID = ""
          listener?.onThread()
          chrome()
          listener?.onSnack(askPlayerMessage(failure))
        }
      }
    }
  }

  /** Used by the preview to show canned turns without the network. */
  internal fun replaceThread(id: String, list: List<AskMessage>, left: Int?) {
    conversationID = id
    messages.clear()
    messages.addAll(list)
    followupsLeft = left
    listener?.onThread()
    chrome()
  }

  internal fun newMessage(question: String, urls: List<String> = emptyList()) = AskMessage(nextLocalId++, question, urls)

  internal fun setPreviewState(name: String, quota: AskUsage, list: List<AskConversationSummary>) {
    profileName = name
    usage = quota
    history = list
    historyLoaded = true
    consented = true
    phase = AskPhase.READY
  }

  // ---- Asking ------------------------------------------------------------

  fun canSend(question: String): Boolean {
    val length = question.trim().length
    val hasPhoto = attachments.any { it.url != null }
    return phase == AskPhase.READY && consented && !sending && !uploading &&
      (length in 5..500 || (length == 0 && hasPhoto)) && usage?.outOfQuestions != true
  }

  fun send(raw: String) {
    val question = raw.trim()
    if (!canSend(question)) return
    if (preview) {
      listener?.onSnack(T.s(R.string.ask_snack_preview))
      return
    }
    if (!online()) {
      listener?.onSnack(T.s(R.string.ask_err_offline))
      return
    }
    val urls = attachments.mapNotNull { it.url }
    val message = newMessage(question.ifBlank { T.s(R.string.ask_photo_prompt) }, urls)
    messages += message
    attachments.clear()
    draft = ""
    listener?.onAttachments()
    listener?.onThread()
    stream(message)
  }

  /** A follow-up chip goes straight out, like the desktop panel. */
  fun sendFollowup(text: String) {
    if (sending) return
    draft = ""
    send(text)
    chrome()
  }

  private fun stream(message: AskMessage) {
    activeMessage = message
    activeReqId = ""
    stopRequested = false
    message.state = AskMessageState.PENDING
    message.status = T.s(R.string.ask_status_thinking)
    message.error = null
    message.revision++
    chrome()
    val conversation = conversationID
    val visualizations = (usage?.vizRemaining ?: 0.0) >= 1.0
    val submitted = submit("Ask answer") {
      try {
        val done = api.ask(message.question, conversation, message.attachmentUrls, visualizations, object : AskStreamListener {
          override fun onMeta(reqId: String, conversationID: String, followupsLeft: Int?) = post("Ask meta") {
            activeReqId = reqId
            if (conversationID.isNotBlank() && activeMessage === message) this@AskSession.conversationID = conversationID
            if (followupsLeft != null) this@AskSession.followupsLeft = followupsLeft
            if (stopRequested && reqId.isNotBlank()) submit("Ask stop") { api.stop(reqId) }
          }
          override fun onStatus(label: String) = post("Ask status") {
            message.status = label
            message.revision++
            touch(message)
          }
          override fun onAction() = post("Ask action") {
            message.checks++
            message.revision++
            touch(message)
          }
          override fun onDelta(text: String) = post("Ask delta") {
            if (message.state == AskMessageState.PENDING) message.state = AskMessageState.STREAMING
            message.answer += text
            message.revision++
            touch(message)
          }
        })
        post("Ask done") {
          message.applyDone(done)
          done.optString("convId").takeIf { it.isNotBlank() }?.let { conversationID = it }
          if (done.has("followupsLeft")) followupsLeft = done.optInt("followupsLeft")
          AskUsage.from(done)?.let { usage = it }
          finish(message)
          loadHistory(silent = true)
        }
      } catch (failure: Exception) {
        post("Ask failure") {
          when {
            stopRequested -> {
              message.state = AskMessageState.STOPPED
              message.status = null
            }
            failure is AskStreamDropped -> {
              message.state = AskMessageState.DROPPED
              message.status = null
              message.error = askPlayerMessage(failure)
            }
            failure is NativeAskAuthRequired -> {
              message.state = AskMessageState.FAILED
              message.error = T.s(R.string.ask_err_signin_ended)
              finish(message)
              signOutLocally()
              return@post
            }
            else -> {
              message.state = AskMessageState.FAILED
              message.status = null
              message.error = if (!online()) T.s(R.string.ask_err_offline) else askPlayerMessage(failure)
              (failure as? AskHttpException)?.usage?.let { usage = it }
            }
          }
          message.revision++
          finish(message)
          if (message.state == AskMessageState.STOPPED) refreshQuota()
        }
      }
    }
    if (!submitted) {
      message.state = AskMessageState.FAILED
      message.error = T.s(R.string.ask_err_unavailable)
      finish(message)
    }
  }

  private fun finish(message: AskMessage) {
    if (activeMessage === message) {
      activeMessage = null
      activeReqId = ""
    }
    flushMessages()
    listener?.onMessage(message)
    chrome()
  }

  fun stop() {
    val message = activeMessage ?: return
    if (stopRequested) return
    stopRequested = true
    message.status = T.s(R.string.ask_status_stopping)
    message.revision++
    touch(message)
    val reqId = activeReqId
    submit("Ask stop") {
      if (reqId.isNotBlank()) api.stop(reqId)
      // The server ends the stream after a stop; cut it locally if it lingers.
      Thread.sleep(1500)
      api.cancelStream()
    }
  }

  /**
   * Retry after a failure or a dropped stream. A dropped answer keeps
   * generating on the server and is saved there, so look for it first and
   * only ask again (and spend another question) when it never arrived.
   */
  fun retry(message: AskMessage) {
    if (sending || preview) return
    if (message.state == AskMessageState.DROPPED && conversationID.isNotBlank()) {
      message.state = AskMessageState.PENDING
      message.status = T.s(R.string.ask_status_recovering)
      message.error = null
      message.revision++
      activeMessage = message
      chrome()
      touch(message)
      val conversation = conversationID
      submit("Ask recover") {
        var recovered: JSONObject? = null
        for (wait in longArrayOf(0, 3000, 6000, 10000)) {
          if (wait > 0) Thread.sleep(wait)
          val turns = runCatching { api.conversation(conversation).optJSONArray("turns") }.getOrNull() ?: continue
          for (index in turns.length() - 1 downTo 0) {
            val turn = turns.optJSONObject(index) ?: continue
            if (turn.optString("question").trim() == message.question.trim() && turn.optString("answer").isNotBlank()) {
              recovered = turn
              break
            }
          }
          if (recovered != null) break
        }
        post("Ask recover UI") {
          activeMessage = null
          val turn = recovered
          if (turn != null) {
            message.answer = turn.optString("answer")
            message.answerId = turn.optLong("id", 0L)
            message.model = askModelLabel(turn, message.model)
            message.citations = askCitations(turn.optJSONArray("citations"))
            message.state = AskMessageState.DONE
            message.status = null
            message.revision++
            finish(message)
            refreshQuota()
          } else {
            message.answer = ""
            stream(message)
          }
        }
      }
      return
    }
    message.answer = ""
    message.checks = 0
    stream(message)
  }

  fun feedback(message: AskMessage, rating: String) {
    if (message.answerId <= 0 && !preview) return
    val previous = message.feedback
    if (previous == rating) return
    message.feedback = rating
    message.revision++
    listener?.onMessage(message)
    listener?.onSnack(if (rating == "up") T.s(R.string.ask_snack_helpful) else T.s(R.string.ask_snack_reported))
    if (preview) return
    submit("Ask feedback") {
      try {
        api.feedback(message.answerId, rating)
      } catch (failure: Exception) {
        post("Ask feedback failure") {
          message.feedback = previous
          message.revision++
          listener?.onMessage(message)
          listener?.onSnack(T.s(R.string.ask_snack_rating_failed, askPlayerMessage(failure)))
        }
      }
    }
  }

  fun share() {
    val id = conversationID
    if (id.isBlank() || messages.none { it.state == AskMessageState.DONE }) {
      listener?.onSnack(T.s(R.string.ask_snack_share_first))
      return
    }
    if (preview) {
      listener?.onShareLink("$NATIVE_ASK_ORIGIN/s/preview")
      return
    }
    submit("Ask share") {
      try {
        val url = api.share(id)
        post("Ask share UI") { listener?.onShareLink(url) }
      } catch (failure: Exception) {
        post("Ask share failure") { listener?.onSnack(askPlayerMessage(failure)) }
      }
    }
  }

  // ---- Photos ------------------------------------------------------------

  fun attachPhoto(uri: Uri) {
    if (attachments.size >= 4) {
      listener?.onSnack(T.s(R.string.ask_snack_four_photos))
      return
    }
    val attachment = AskAttachment(nextLocalId++, "photo.jpg")
    attachments += attachment
    listener?.onAttachments()
    chrome()
    submit("Ask photo") {
      try {
        val (bytes, thumb) = preparePhoto(uri)
        post("Ask photo thumb") {
          attachment.thumbnail = thumb
          listener?.onAttachments()
        }
        if (preview) {
          post("Ask photo preview") { attachment.uploading = false; attachment.url = "/api/uploads/preview"; listener?.onAttachments(); chrome() }
          return@submit
        }
        val url = api.upload(bytes, "photo-${System.currentTimeMillis()}.jpg", "image/jpeg")
        post("Ask photo uploaded") {
          if (attachment !in attachments) { submit("Ask photo cleanup") { api.removeUpload(url) }; return@post }
          attachment.url = url
          attachment.uploading = false
          listener?.onAttachments()
          chrome()
        }
      } catch (failure: Exception) {
        post("Ask photo failure") {
          attachment.uploading = false
          attachment.error = if (failure is SecurityException) T.s(R.string.ask_err_photo_open) else askPlayerMessage(failure)
          listener?.onAttachments()
          chrome()
          listener?.onSnack(attachment.error ?: T.s(R.string.ask_err_photo_attach))
        }
      }
    }
  }

  fun removeAttachment(attachment: AskAttachment) {
    attachments.remove(attachment)
    listener?.onAttachments()
    chrome()
    val url = attachment.url
    if (url != null && !preview) submit("Ask photo remove") { api.removeUpload(url) }
  }

  /**
   * Downscale to 2048 px JPEG: well under the 10 MB limit, quick on mobile
   * data. ImageDecoder (API 28+) also applies the camera's rotation.
   */
  private fun preparePhoto(uri: Uri): Pair<ByteArray, Bitmap> {
    val resolver = appContext.contentResolver
    val decoded: Bitmap = if (Build.VERSION.SDK_INT >= 28) {
      val source = android.graphics.ImageDecoder.createSource(resolver, uri)
      android.graphics.ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val longest = Math.max(info.size.width, info.size.height)
        if (longest > 2048) {
          val scale = 2048f / longest
          decoder.setTargetSize(Math.max(1, (info.size.width * scale).toInt()), Math.max(1, (info.size.height * scale).toInt()))
        }
        decoder.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE
      }
    } else {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw AskCopyException(T.s(R.string.ask_err_not_photo))
      var sample = 1
      while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2048) sample *= 2
      resolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
      } ?: throw AskCopyException(T.s(R.string.ask_err_photo_open))
    }
    val scale = Math.min(1f, 2048f / Math.max(decoded.width, decoded.height))
    val sized = if (scale < 1f) Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt(), (decoded.height * scale).toInt(), true) else decoded
    val out = ByteArrayOutputStream()
    sized.compress(Bitmap.CompressFormat.JPEG, 85, out)
    val thumbScale = 160f / Math.max(sized.width, sized.height)
    val thumb = Bitmap.createScaledBitmap(sized, Math.max(1, (sized.width * thumbScale).toInt()), Math.max(1, (sized.height * thumbScale).toInt()), true)
    return out.toByteArray() to thumb
  }

  /** Thumbnail for a photo attached to a saved turn. */
  fun loadUpload(url: String, done: (Bitmap?) -> Unit) {
    uploadCache.get(url)?.let { done(it); return }
    if (preview) { done(null); return }
    submit("Ask upload thumb") {
      val bitmap = runCatching {
        val bytes = api.uploadBytes(url)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 320) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
      }.getOrNull()
      post("Ask upload thumb UI") {
        if (bitmap != null) uploadCache.put(url, bitmap)
        done(bitmap)
      }
    }
  }

  // ---- Maps --------------------------------------------------------------

  fun renderMap(spec: String, done: (String?, String?) -> Unit) {
    mapCache.get(spec)?.let { done(it, null); return }
    if (preview) { done(null, T.s(R.string.ask_map_preview)); return }
    submit("Ask map") {
      try {
        val svg = api.renderMap(spec)
        post("Ask map UI") { mapCache.put(spec, svg); done(svg, null) }
      } catch (failure: Exception) {
        post("Ask map failure") { done(null, if (!online()) T.s(R.string.ask_map_offline) else T.s(R.string.ask_err_map)) }
      }
    }
  }

  // ---- Plumbing ----------------------------------------------------------

  fun online(): Boolean = NativeSafety.get("Ask connectivity", true) {
    val manager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return@get true
    if (Build.VERSION.SDK_INT >= 23) {
      val network = manager.activeNetwork ?: return@get false
      manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ?: false
    } else {
      @Suppress("DEPRECATION")
      manager.activeNetworkInfo?.isConnected ?: false
    }
  }

  /** Coalesce streaming redraws to about 12 a second. */
  private fun touch(message: AskMessage) {
    dirtyMessages += message
    if (pendingMessageFlush != null) return
    val wait = Math.max(0L, 80L - (SystemClock.uptimeMillis() - lastFlush))
    val flush = Runnable { NativeSafety.run("Ask message flush") { flushMessages() } }
    pendingMessageFlush = flush
    main.postDelayed(flush, wait)
  }

  private fun flushMessages() {
    pendingMessageFlush?.let { main.removeCallbacks(it) }
    pendingMessageFlush = null
    lastFlush = SystemClock.uptimeMillis()
    val list = dirtyMessages.toList()
    dirtyMessages.clear()
    list.forEach { listener?.onMessage(it) }
  }

  private fun chrome() {
    listener?.onChrome()
  }

  private fun post(operation: String, block: () -> Unit) {
    main.post { NativeSafety.run(operation) { block() } }
  }

  private fun submit(operation: String, task: () -> Unit): Boolean = NativeSafety.run("$operation scheduling") {
    worker.execute { NativeSafety.run("$operation task") { task() } }
  }

  fun shutdown() {
    api.cancelStream()
    worker.shutdownNow()
    main.removeCallbacksAndMessages(null)
  }

  private fun profileNameOf(profile: JSONObject): String {
    val identity = profile.optJSONObject("identity")
    val profileContext = profile.optJSONObject("context")
    val character = profileContext?.optJSONObject("character")
    return identity?.optString("name").orEmpty().ifBlank { identity?.optString("displayName").orEmpty() }
      .ifBlank { character?.optString("name").orEmpty() }
      .ifBlank { profileContext?.optString("displayName").orEmpty() }
      .ifBlank { identity?.optString("username").orEmpty() }
      .takeIf { it != "null" }.orEmpty()
  }
}

/** One live session per process, plus a throwaway one for the screenshot preview. */
internal object AskStore {
  private var live: AskSession? = null

  fun live(context: Context, cookies: () -> Map<String, String>): AskSession {
    val current = live
    if (current != null) {
      current.refreshCookies(cookies())
      return current
    }
    return AskSession(context, cookies(), preview = false).also { live = it }
  }

  fun preview(context: Context): AskSession = AskSession(context, emptyMap(), preview = true).also(AskPreview::fill)
}
