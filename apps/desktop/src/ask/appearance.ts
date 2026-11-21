import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";

export function followAskAppearance(): void {
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let nativeTheme: Theme | null = null;
  const apply = () => {
    root.dataset.askTheme = nativeTheme ?? (media.matches ? "dark" : "light");
  };
  apply();
  media.addEventListener("change", apply);
  if (!isTauri()) return;

  const askWindow = getCurrentWindow();
  let changed = false;
  void askWindow.onThemeChanged(({ payload }) => {
    changed = true;
    nativeTheme = payload;
    apply();
  }).catch(() => {}).then(async () => {
    const theme = await askWindow.theme();
    if (changed) return;
    nativeTheme = theme;
    apply();
  }).catch(() => {});
}
