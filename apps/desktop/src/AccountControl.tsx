import { useEffect, useRef } from "react";
import { allowedAvatarUrl, initialsFor } from "./avatar.js";

interface Props {
  checked: boolean;
  linked: boolean;
  displayName: string | undefined;
  avatarUrl?: string | null | undefined;
  supporter: boolean | undefined;
  onLink: () => void;
  onProfile: () => void;
  onManage: () => void;
  onSignOut: () => void;
  signingOut?: boolean;
}

export function AccountControl({ checked, linked, displayName, avatarUrl, supporter, onLink, onProfile, onManage, onSignOut, signingOut = false }: Props): JSX.Element {
  const menu = useRef<HTMLDetailsElement>(null);
  // A menu closes when the player taps or clicks anywhere else, like every
  // native menu; a bare <details> stayed open until its own summary was hit.
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const element = menu.current;
      if (element?.open && !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  if (checked && linked) {
    const avatar = allowedAvatarUrl(avatarUrl);
    const choose = (action: () => void) => () => {
      if (menu.current) menu.current.open = false;
      action();
    };
    return (
      <details
        ref={menu}
        className="client-account-menu"
        onKeyDown={(event) => {
          // Escape closes the menu instead of reaching the launcher, where it
          // toggles Settings.
          if (event.key !== "Escape" || !menu.current?.open) return;
          event.stopPropagation();
          menu.current.open = false;
          menu.current.querySelector("summary")?.focus();
        }}
      >
        <summary className="client-account-control">
          {avatar ? (
            <img className="client-account-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="client-account-avatar" aria-hidden="true">{initialsFor(displayName)}</span>
          )}
          <span className="client-account-name">{displayName || "Profile"}</span>
          <span aria-hidden="true">⌄</span>
        </summary>
        <div role="menu">
          <p><strong>{displayName || "Game account"}</strong><small>{supporter ? "Supporter" : "Player"}</small></p>
          <button role="menuitem" type="button" onClick={choose(onProfile)}>View profile</button>
          <button role="menuitem" type="button" onClick={choose(onManage)}>Manage game account</button>
          <button role="menuitem" type="button" onClick={onSignOut} disabled={signingOut}>
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </details>
    );
  }
  return (
    <button className="client-account-control" type="button" disabled={!checked} onClick={onLink}>
      {!checked ? "Account" : "Link account"}
    </button>
  );
}
