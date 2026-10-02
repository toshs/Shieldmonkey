import { useMemo, useRef, useState } from 'react';
import { ClipboardCopy, ClipboardPaste, ExternalLink, X } from 'lucide-react';
import { bridge } from '../../bridge/client';
import { useI18n } from '../../context/I18nContext';
import { copyText } from '../../../utils/clipboard';
import { extractUserscript, hasUserscriptHeader } from '../../../utils/scriptTransfer';
import { parseMetadata } from '../../../utils/metadataParser';
import './AiTransferDialog.css';

type AiProvider = 'chatgpt' | 'claude' | 'gemini';
type DialogMode = 'ask' | 'paste';

interface Props {
    code: string;
    initialMode: DialogMode;
    onApply: (code: string) => void;
    onClose: () => void;
}

export default function AiTransferDialog({ code, initialMode, onApply, onClose }: Props) {
    const { t } = useI18n();
    const [mode, setMode] = useState<DialogMode>(initialMode);
    const [task, setTask] = useState(t('aiDefaultTask'));
    const [answer, setAnswer] = useState('');
    const [notice, setNotice] = useState('');
    const promptRef = useRef<HTMLTextAreaElement>(null);
    const answerRef = useRef<HTMLTextAreaElement>(null);

    const prompt = useMemo(() => [
        t('aiPromptIntro'),
        `${t('aiPromptTask')}: ${task.trim() || t('aiDefaultTask')}`,
        t('aiPromptRules'),
        '',
        '```javascript',
        code.trim(),
        '```'
    ].join('\n'), [code, task, t]);
    const importedCode = useMemo(() => extractUserscript(answer), [answer]);
    const validScript = hasUserscriptHeader(importedCode);
    const importedName = validScript ? parseMetadata(importedCode).name : '';

    const selectPrompt = () => {
        promptRef.current?.focus();
        promptRef.current?.select();
    };

    const handleCopyPrompt = async () => {
        if (await copyText(prompt)) {
            setNotice(t('aiPromptCopied'));
        } else {
            setNotice(t('aiCopyManually'));
            selectPrompt();
        }
    };

    const handleOpenProvider = async (provider: AiProvider) => {
        if (!(await copyText(prompt))) {
            setNotice(t('aiCopyManually'));
            selectPrompt();
            return;
        }
        try {
            await bridge.call('OPEN_AI_SERVICE', provider);
            setNotice(t('aiPromptCopied'));
        } catch (error) {
            setNotice((error as Error).message);
        }
    };

    const handleReadClipboard = async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (!text.trim()) throw new Error('Empty clipboard');
            setAnswer(text);
            setNotice('');
        } catch {
            setNotice(t('aiPasteManually'));
            answerRef.current?.focus();
        }
    };

    return (
        <div className="ai-dialog-overlay" onClick={onClose}>
            <section className="ai-dialog" role="dialog" aria-modal="true" aria-label={t('aiDialogTitle')} onClick={event => event.stopPropagation()}>
                <header className="ai-dialog-header">
                    <h2>{t('aiDialogTitle')}</h2>
                    <button className="icon-btn" onClick={onClose} aria-label={t('modalClose')}><X size={20} /></button>
                </header>
                <div className="ai-dialog-tabs">
                    <button className={mode === 'ask' ? 'active' : ''} onClick={() => { setMode('ask'); setNotice(''); }}>{t('aiAskTab')}</button>
                    <button className={mode === 'paste' ? 'active' : ''} onClick={() => { setMode('paste'); setNotice(''); }}>{t('aiPasteTab')}</button>
                </div>
                <div className="ai-dialog-body">
                    {mode === 'ask' ? (
                        <>
                            <label htmlFor="ai-task">{t('aiTaskLabel')}</label>
                            <textarea id="ai-task" className="ai-task-input" value={task} onChange={event => setTask(event.target.value)} />
                            <label htmlFor="ai-prompt">{t('aiPromptPreview')}</label>
                            <textarea id="ai-prompt" ref={promptRef} className="ai-prompt-preview" value={prompt} readOnly onFocus={event => event.target.select()} />
                            <button className="btn-secondary" onClick={handleCopyPrompt}><ClipboardCopy size={18} />{t('aiCopyPrompt')}</button>
                            <p className="ai-dialog-hint">{t('aiOpenHint')}</p>
                            <div className="ai-provider-buttons">
                                <button className="btn-secondary" onClick={() => handleOpenProvider('chatgpt')}>ChatGPT <ExternalLink size={16} /></button>
                                <button className="btn-secondary" onClick={() => handleOpenProvider('claude')}>Claude <ExternalLink size={16} /></button>
                                <button className="btn-secondary" onClick={() => handleOpenProvider('gemini')}>Gemini <ExternalLink size={16} /></button>
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="ai-dialog-hint">{t('aiPasteHint')}</p>
                            <button className="btn-secondary" onClick={handleReadClipboard}><ClipboardPaste size={18} />{t('aiReadClipboard')}</button>
                            <label htmlFor="ai-answer">{t('aiAnswerLabel')}</label>
                            <textarea id="ai-answer" ref={answerRef} className="ai-answer-input" value={answer} onChange={event => { setAnswer(event.target.value); setNotice(''); }} placeholder={t('aiAnswerPlaceholder')} />
                            {answer && <div className={validScript ? 'ai-validation valid' : 'ai-validation invalid'}>
                                {validScript ? t('aiReadyToApply', [importedName || t('aiUnnamedScript')]) : t('aiMissingHeader')}
                            </div>}
                            <p className="ai-dialog-hint">{t('aiReplaceHint')}</p>
                            <button className="btn-primary" disabled={!validScript} onClick={() => { onApply(importedCode); onClose(); }}>{t('aiApplyCode')}</button>
                        </>
                    )}
                    {notice && <p className="ai-dialog-notice" role="status">{notice}</p>}
                </div>
            </section>
        </div>
    );
}
