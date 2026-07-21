import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

// Locale-aware navigation primitives. Use these EVERYWHERE instead of the ones
// from `next/link` / `next/navigation` so internal links keep the active locale
// prefix automatically (`<Link href="/dashboard">` → `/es/dashboard`).
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
