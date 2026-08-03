/**
 * Prompt and confirm dialogs.
 *
 * Electron disables the browser's own `window.prompt`, and a vault asks a lot
 * of small questions — name this note, are you sure about deleting that folder —
 * so they get a real component and a promise-shaped API.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface PromptRequest {
  kind: 'prompt' | 'confirm';
  title: string;
  message?: string;
  initial: string;
  confirmLabel: string;
  danger?: boolean;
  resolve(value: string | null): void;
}

export interface Ui {
  prompt(title: string, initial?: string, options?: { message?: string; confirmLabel?: string }): Promise<string | null>;
  confirm(title: string, options?: { message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  notify(message: string): void;
}

const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi must be used inside <UiProvider>');
  return ui;
}

export function UiProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const [value, setValue] = useState('');
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const ask = useCallback((next: Omit<PromptRequest, 'resolve'>) => {
    return new Promise<string | null>((resolve) => {
      setValue(next.initial);
      setRequest({ ...next, resolve });
    });
  }, []);

  const ui = useMemo<Ui>(
    () => ({
      prompt: (title, initial = '', options) =>
        ask({
          kind: 'prompt',
          title,
          message: options?.message,
          initial,
          confirmLabel: options?.confirmLabel ?? 'OK',
        }),
      confirm: async (title, options) => {
        const result = await ask({
          kind: 'confirm',
          title,
          message: options?.message,
          initial: '',
          confirmLabel: options?.confirmLabel ?? 'Confirm',
          danger: options?.danger,
        });
        return result !== null;
      },
      notify: (message) => {
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        setToast({ id: Date.now(), message });
        toastTimer.current = window.setTimeout(() => setToast(null), 2600);
      },
    }),
    [ask],
  );

  const close = (result: string | null) => {
    request?.resolve(result);
    setRequest(null);
  };

  return (
    <UiContext.Provider value={ui}>
      {children}
      {request ? (
        <div className="modal-backdrop" onMouseDown={() => close(null)}>
          <div className="modal modal-prompt" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title">{request.title}</div>
            {request.message ? <div className="modal-message">{request.message}</div> : null}
            {request.kind === 'prompt' ? (
              <input
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') close(value);
                  if (event.key === 'Escape') close(null);
                }}
              />
            ) : null}
            <div className="modal-buttons">
              <button onClick={() => close(null)} type="button">
                Cancel
              </button>
              <button
                className={request.danger ? 'danger-solid' : 'primary'}
                autoFocus={request.kind === 'confirm'}
                onClick={() => close(request.kind === 'confirm' ? 'yes' : value)}
                type="button"
              >
                {request.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast.message}</div> : null}
    </UiContext.Provider>
  );
}
