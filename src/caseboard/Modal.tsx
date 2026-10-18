import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export default function Modal({ title, subtitle = 'YAOZHUO / LOCAL ARCHIVE', children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLElement>(null), close = useRef(onClose), id = useId()
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current() }
      if (event.key !== 'Tab') return
      const elements = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')
      if (!elements?.length) { event.preventDefault(); return }
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus() }
  }, [])
  return createPortal(<div className="modal-shade" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className={`pixel-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={panel}><header><div><small>{subtitle}</small><h2 id={id}>{title}</h2></div><button className="icon-btn" aria-label="關閉彈窗" onClick={onClose}>×</button></header>{children}</section></div>, document.querySelector('.case-app') || document.body)
}
