import { expect, test } from 'vitest';
import { popupTexts } from '../../src/popup/messages';
import enMessages from '../../public/_locales/en/messages.json';
import jaMessages from '../../public/_locales/ja/messages.json';

test('popup labels stay in sync with extension translations', () => {
    for (const [language, allMessages] of [['en', enMessages], ['ja', jaMessages]] as const) {
        for (const [key, value] of Object.entries(popupTexts[language])) {
            expect((allMessages as Record<string, { message: string }>)[key]?.message, `${language}.${key}`).toBe(value);
        }
    }
});
