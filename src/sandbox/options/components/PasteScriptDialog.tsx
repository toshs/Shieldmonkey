import { useMemo, useRef, useState } from 'react';
import { ClipboardPaste, X } from 'lucide-react';
import { useI18n } from '../../context/I18nContext';
import { extractUserscript, hasUserscriptHeader } from '../../../utils/scriptTransfer';
import { parseMetadata } from '../../../utils/metadataParser';
import './PasteScriptDialog.css';

interface Props {
    onApply: (code: string) => void;
    onClose: () => void;
}

export default function PasteScriptDialog({ onApply, onClose }: Props) {
    const { t } = useI18n();
    const [text, setText] = useState('');
    const [notice, setNotice] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const code = useMemo(() => extractUserscript(text), [text]);
    const validScript = hasUserscriptHeader(code);
    const scriptName = validScript ? parseMetadata(code).name : '';

    const pasteFromClipboard = async () => {
        try {
            const value = await navigator.clipboard.readText();
            if (!value.trim()) throw new Error('Empty clipboard');
            setText(value);
            setNotice('');
        } catch {
            setNotice(t('pasteManually'));
            inputRef.current?.focus();
        }
    };

    return (
        <div className="paste-dialog-overlay" onClick={onClose}>
            <section className="paste-dialog" role="dialog" aria-modal="true" aria-label={t('pasteDialogTitle')} onClick={event => event.stopPropagation()}>
                <header className="paste-dialog-header">
                    <h2>{t('pasteDialogTitle')}</h2>
                    <button className="icon-btn" onClick={onClose} aria-label={t('modalClose')}><X size={20} /></button>
                </header>
                <div className="paste-dialog-body">
                    <p className="paste-dialog-hint">{t('pasteHint')}</p>
                    <button className="btn-secondary" onClick={pasteFromClipboard}><ClipboardPaste size={18} />{t('pasteFromClipboard')}</button>
                    <label htmlFor="paste-script-code">{t('pasteCodeLabel')}</label>
                    <textarea id="paste-script-code" ref={inputRef} value={text} onChange={event => { setText(event.target.value); setNotice(''); }} placeholder={t('pasteCodePlaceholder')} />
                    {text && <div className={validScript ? 'paste-validation valid' : 'paste-validation invalid'}>
                        {validScript ? t('pasteReady', [scriptName || t('pasteUnnamedScript')]) : t('pasteMissingHeader')}
                    </div>}
                    <p className="paste-dialog-hint">{t('pasteReplaceHint')}</p>
                    <button className="btn-primary" disabled={!validScript} onClick={() => { onApply(code); onClose(); }}>{t('pasteApplyCode')}</button>
                    {notice && <p className="paste-dialog-notice" role="status">{notice}</p>}
                </div>
            </section>
        </div>
    );
}
