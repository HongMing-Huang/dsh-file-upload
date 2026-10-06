/**
 * Type declarations for the browser half's one external dependency.
 *
 * `src/client/**` imports `@deepseek-ai/dsh-client-ui-primitives`, which ships
 * inside the DSH runtime rather than this repository, so it is absent from
 * `node_modules` here. Without a declaration, `tsc` cannot check the browser
 * half at all — and it did not, for a long time: `tsconfig.json` only included
 * `**\/*.ts`, so the 700+ line `.tsx` client was never typechecked. Re-enabling
 * that check immediately found three real defects the build had been shipping:
 * the error banner dereferenced `undefined.text`; both imported icons were
 * names the runtime does not export, so the paperclip and every remove button
 * rendered nothing; and `Tooltip` was passed a `side` prop it does not accept.
 *
 * The stub has to be *correct*, too: the first version of this file guessed the
 * prop names, and `tsc` rejected the real call sites — which is the point.
 *
 * This file is deliberately MINIMAL: it declares only the symbols the client
 * actually imports, so a type error in client code is caught while an unused or
 * newly added primitive is not silently blessed. It is a compile-time stub —
 * never imported at runtime, never emitted (`tsconfig.json` sets `noEmit`), and
 * not part of the published package (`package.json#files` ships `lib` only).
 *
 * When a primitive is added to the client's imports, add it here too, and keep
 * the signature faithful to the runtime. The authoritative implementation lives
 * in the DSH install at
 * `node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js` — that
 * package ships no `.d.ts`, so read the function signature there.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  /**
   * Hover/focus tooltip wrapper. `label` may be a function so it is resolved
   * lazily; `side`/`align` place the bubble. `side: 'top'` is the default used
   * by this plugin's composer button.
   */
  export function Tooltip(props: {
    label: ReactNode | (() => ReactNode)
    side?: 'top' | 'right' | 'bottom' | 'left'
    align?: 'start' | 'center' | 'end'
    delayMs?: number
    gap?: number
    disabled?: boolean
    children?: ReactNode
  }): ReactNode

  /**
   * Size-graded glyph families. The runtime exports `…Regular` (≈16px) and
   * `…Medium` (≈20px) grades — there is no `…16` suffix in the shipped
   * package. Each icon takes a numeric `size` in pixels.
   */
  export interface IconProps {
    size?: number
    className?: string
  }

  export function IconPaperclipOutlineRegular(props: IconProps): ReactNode
  export function IconCloseOutlineRegular(props: IconProps): ReactNode
}
