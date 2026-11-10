# Run after `tauri ios init`, before `tauri ios build`. Keep the extension in
# XcodeGen's source spec so project regeneration retains it.
require 'yaml'
require 'fileutils'
require 'json'

root = File.expand_path('..', __dir__)
tauri = File.join(root, 'apps/desktop/src-tauri')
project = File.join(tauri, 'gen/apple')
spec_path = File.join(project, 'project.yml')
spec = YAML.load_file(spec_path)
app_name, app = spec.fetch('targets').find { |name, target| target['type'] == 'application' && target['platform'] == 'iOS' }
abort 'Expected one iOS app target' unless app
team = ENV.fetch('APPLE_DEVELOPMENT_TEAM', '').strip
abort 'APPLE_DEVELOPMENT_TEAM is required to configure iOS widgets' if team.empty?
keychain = "#{team}.net.lakesidegames.ahdclient.widgets"
entitlements = { 'keychain-access-groups' => [keychain] }
app['entitlements'] ||= { 'path' => "#{app_name}/#{app_name}.entitlements" }
app['entitlements']['properties'] ||= {}
entitlements.each do |key, values|
  app['entitlements']['properties'][key] = (Array(app['entitlements']['properties'][key]) + values).uniq
end
# Literal, not $(AHD_PUSH_ENVIRONMENT): the placeholder resolved in Info.plist
# but came out empty in the signed entitlements, so iOS refused APNs
# registration on every device. Every signed build here is App Store/TestFlight.
app['entitlements']['properties']['aps-environment'] = 'production'
app['settings'] ||= {}
app['settings']['base'] ||= {}
app['settings']['base']['AHD_WIDGET_KEYCHAIN_GROUP'] = keychain
# iPhone and iPad (1,2). Shipping the iPad family is irreversible: a version that
# has shipped with it can never drop it. The widget extension below also targets
# iPhone and iPad so the widgets can be added on an iPad Home Screen.
app['settings']['base']['TARGETED_DEVICE_FAMILY'] = '1,2'
app['settings']['configs'] ||= {}
app['settings']['configs']['debug'] ||= {}
app['settings']['configs']['release'] ||= {}
app['settings']['configs']['debug']['AHD_PUSH_ENVIRONMENT'] = 'development'
app['settings']['configs']['release']['AHD_PUSH_ENVIRONMENT'] = 'production'
app.fetch('info').fetch('properties')['AHDPushEnvironment'] = '$(AHD_PUSH_ENVIRONMENT)'
app.fetch('info').fetch('properties')['AHDWidgetKeychainGroup'] = keychain
# Privacy manifest (required-reason APIs and collected data) ships as an app
# resource; App Store Connect rejects uploads that use those APIs without it.
FileUtils.cp(File.join(tauri, 'PrivacyInfo.xcprivacy'), project)
app['sources'] ||= []
unless app['sources'].any? { |s| (s.is_a?(Hash) ? s['path'] : s) == 'PrivacyInfo.xcprivacy' }
  app['sources'] << { 'path' => 'PrivacyInfo.xcprivacy', 'buildPhase' => 'resources' }
end
app['dependencies'] ||= []
app['dependencies'] << { 'target' => 'AHDWidgets', 'embed' => true } unless app['dependencies'].any? { |d| d['target'] == 'AHDWidgets' }

extension = File.join(project, 'AHDWidgets')
FileUtils.mkdir_p(extension)
FileUtils.cp(File.join(tauri, 'ios-widgets/AHDWidgets.swift'), extension)
# The Liberty Bell mark; XcodeGen bundles loose PNGs in the sources path as resources.
Dir.glob(File.join(tauri, 'ios-widgets/*.png')).each { |image| FileUtils.cp(image, extension) }
FileUtils.cp(File.join(tauri, 'plugins/briefing-widgets/ios/Sources/BriefingStore.swift'), extension)
version = JSON.parse(File.read(File.join(root, 'package.json'))).fetch('version')
app_info = app.fetch('info').fetch('properties')
spec['targets']['AHDWidgets'] = {
  'type' => 'app-extension', 'platform' => 'iOS', 'deploymentTarget' => '15.0',
  'sources' => [{ 'path' => 'AHDWidgets', 'excludes' => ['*.plist', '*.entitlements'] }],
  'settings' => {
    'groups' => ['app'],
    'base' => {
      'PRODUCT_NAME' => 'AHDWidgets',
      'PRODUCT_BUNDLE_IDENTIFIER' => 'net.lakesidegames.ahdclient.widgets',
      'SWIFT_VERSION' => '5.0', 'SKIP_INSTALL' => 'YES',
      'TARGETED_DEVICE_FAMILY' => '1,2',
      'APPLICATION_EXTENSION_API_ONLY' => 'YES',
      'CODE_SIGN_STYLE' => 'Automatic'
    }
  },
  'info' => {
    'path' => 'AHDWidgets/Info.plist',
    'properties' => {
      'CFBundleDisplayName' => 'AHD Briefing',
      'CFBundleShortVersionString' => version,
      'CFBundleVersion' => app_info.fetch('CFBundleVersion').to_s,
      'AHDWidgetKeychainGroup' => keychain,
      'NSExtension' => { 'NSExtensionPointIdentifier' => 'com.apple.widgetkit-extension' }
    }
  },
  'entitlements' => { 'path' => 'AHDWidgets/AHDWidgets.entitlements', 'properties' => entitlements },
  'dependencies' => [{ 'sdk' => 'WidgetKit.framework' }, { 'sdk' => 'SwiftUI.framework' }, { 'sdk' => 'Security.framework' }]
}
# Appearance: the app follows the system setting so native sheets (Ask) can be
# light, while the launcher pins its own window dark at runtime. Paint the
# launch screen the launcher color (#14141c) so light-mode players never see a
# white frame before the launcher draws.
props = app.fetch('info').fetch('properties')
props.delete('UIUserInterfaceStyle')
launch_color = '<color key="backgroundColor" red="0.0784313725" green="0.0784313725" blue="0.1098039216" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>'
storyboards = Dir.glob(File.join(project, '**', '*.storyboard')).select { |path| File.read(path).include?('launchScreen="YES"') }
storyboards.each do |path|
  xml = File.read(path)
  patched = xml.gsub(/<color key="backgroundColor"[^>]*\/>/, launch_color)
  patched = patched.sub(/(<view key="view"[^>]*>)/) { "#{Regexp.last_match(1)}\n#{launch_color}" } unless patched.include?(launch_color)
  File.write(path, patched)
  puts "Launch screen painted the launcher color: #{path.sub("#{project}/", '')}"
end
assets = Dir.glob(File.join(project, '**', 'Assets.xcassets')).first
if assets
  colorset = File.join(assets, 'LaunchBackground.colorset')
  FileUtils.mkdir_p(colorset)
  File.write(File.join(colorset, 'Contents.json'), JSON.pretty_generate(
    'colors' => [{ 'idiom' => 'universal', 'color' => { 'color-space' => 'srgb',
      'components' => { 'red' => '0x14', 'green' => '0x14', 'blue' => '0x1C', 'alpha' => '1.000' } } }],
    'info' => { 'author' => 'xcode', 'version' => 1 }
  ))
end
if storyboards.empty?
  # No launch storyboard: a plain launch screen in the launcher color.
  props.delete('UILaunchStoryboardName')
  props['UILaunchScreen'] = { 'UIColorName' => 'LaunchBackground' }
  puts 'Launch screen set to the launcher color (UILaunchScreen).'
end
File.write(spec_path, YAML.dump(spec))
abort 'XcodeGen failed' unless system('xcodegen', 'generate', '--spec', spec_path, '--project', project)
puts 'AHD Profile, Election and Corporation widgets added to the iOS app.'
