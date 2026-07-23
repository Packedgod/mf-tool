// Next.js resolves the "@/" path alias through its own bundler config, which plain Node
// knows nothing about. The sync scripts import the same lib modules the app uses, so they
// register this resolver first to map "@/x" onto the project root.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

export function resolve(specifier, context, next) {
  if (!specifier.startsWith('@/')) return next(specifier, context);
  const target = specifier.slice(2);
  // Only a real module extension counts. A bare dot is not enough: paths such as
  // "@/data/manager-registry.generated" would otherwise look extensioned and never
  // resolve to the .js file on disk.
  const withExtension = /\.(js|mjs|cjs|json)$/i.test(target) ? target : `${target}.js`;
  return next(pathToFileURL(path.join(ROOT, withExtension)).href, context);
}
