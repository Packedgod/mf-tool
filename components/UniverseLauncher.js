'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function UniverseLauncher() {
  const pathname = usePathname();
  if (pathname === '/universe') return null;
  return (
    <Link className="universe-launcher" href="/universe" aria-label="Open all mutual funds and managers directory">
      <span>MF</span>
      <strong>All funds</strong>
    </Link>
  );
}
