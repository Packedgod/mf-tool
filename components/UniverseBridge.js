'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

function setReactInput(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export default function UniverseBridge() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (pathname !== '/') return undefined;
    const amfiCode = searchParams.get('amfiCode');
    const managerName = searchParams.get('managerName');
    if (!amfiCode && !managerName) return undefined;

    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;

      if (managerName) {
        const buttons = [...document.querySelectorAll('.manager-list button')];
        const match = buttons.find(button => button.textContent?.toLowerCase().includes(managerName.toLowerCase()));
        if (match) match.click();
      }

      if (amfiCode) {
        const input = [...document.querySelectorAll('input')].find(element =>
          element.getAttribute('placeholder')?.toLowerCase().includes('leave blank for automatic resolution')
        );
        if (input) {
          setReactInput(input, amfiCode);
          const container = input.closest('.code-control');
          const apply = [...(container?.querySelectorAll('button') || [])].find(button => button.textContent?.trim() === 'Apply');
          if (apply) {
            window.setTimeout(() => apply.click(), 120);
            window.clearInterval(timer);
            window.history.replaceState({}, '', '/');
          }
        }
      }

      if (attempts >= 30) window.clearInterval(timer);
    }, 200);

    return () => window.clearInterval(timer);
  }, [pathname, searchParams]);

  return null;
}
