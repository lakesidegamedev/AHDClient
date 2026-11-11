import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { DE } from "./i18n.de.js";
import { EN } from "./i18n.en.js";

export type ClientLanguage = "en" | "de";

const COPY = { en: EN, de: DE } as const;

export type TranslationKey = keyof typeof EN;
export type TranslationVars = Record<string, string | number>;

export function defaultLanguage(locales: readonly string[] = navigator.languages): ClientLanguage {
  return locales.some((locale) => locale.toLowerCase().startsWith("de")) ? "de" : "en";
}

/** Looks the key up and fills `{name}` placeholders from `vars`. */
export function translate(language: ClientLanguage, key: TranslationKey, vars?: TranslationVars): string {
  const text: string = COPY[language][key] ?? EN[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export type Translator = (key: TranslationKey, vars?: TranslationVars) => string;

const LanguageContext = createContext<ClientLanguage>("en");

/** Screens read the language from here, so it never has to be passed down by hand. */
export function LanguageProvider({ language, children }: { language: ClientLanguage; children: ReactNode }): JSX.Element {
  return createElement(LanguageContext.Provider, { value: language }, children);
}

export function useLanguage(): ClientLanguage {
  return useContext(LanguageContext);
}

export function useT(): Translator {
  const language = useContext(LanguageContext);
  return useMemo(() => (key, vars) => translate(language, key, vars), [language]);
}
