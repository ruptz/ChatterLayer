'use client';

import { useEffect, useState } from 'react';

/**
 * The overlay URL, set in mono because that's how the app shows it and how
 * OBS will take it. The button says what happened after it happens —
 * "Copied" — rather than staying on the imperative and leaving you guessing.
 */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard permission refused, or an insecure origin. The value is
      // selectable either way, so there's nothing to recover from.
    }
  };

  return (
    <div className="slab-sm flex max-w-[34rem] items-stretch">
      <input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 bg-paper px-4 py-3 font-mono text-[0.9375rem] font-medium text-ink outline-none"
      />
      <button
        type="button"
        onClick={copy}
        className={`shrink-0 border-l-[3px] border-ink px-5 text-[0.9375rem] font-bold transition-colors ${
          copied ? 'bg-s1' : 'bg-s2'
        }`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
