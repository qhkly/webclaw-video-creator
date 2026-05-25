import { createContext, useContext, useState, type ReactNode } from 'react';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

export type Locale = 'zh-CN' | 'en-US';

type Translations = typeof zhCN;

const locales: Record<Locale, Translations> = { 'zh-CN': zhCN, 'en-US': enUS };

const I18nContext = createContext<{
  t: Translations;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}>({ t: zhCN, locale: 'zh-CN', setLocale: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('zh-CN');
  return (
    <I18nContext.Provider value={{ t: locales[locale], locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export const useI18n = () => useContext(I18nContext);
