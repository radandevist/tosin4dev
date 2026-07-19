import { useEffect } from "react";

// A right-side slide-over dialog. Board content stays visible behind the
// backdrop; Escape or a backdrop click closes back to the board. Not a full
// focus trap — deep focus polish is deferred to Task 9.
export function OverlayPanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-zinc-900/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-zinc-200 bg-white shadow-xl"
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-zinc-200 bg-white/90 px-6 py-4 backdrop-blur">
          <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Close
          </button>
        </header>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
