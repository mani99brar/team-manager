/**
 * Compile-time checks of the primitives' callback props (`tsc -b` in `npm run build` reads this file; nothing imports it).
 * A prop that shares its name with a DOM handler of the `div` it renders (`onToggle`, `onSelect`) must be omitted from the
 * forwarded `div` props, or its type becomes an intersection with the DOM handler and a correctly typed callback no longer
 * compiles (general review of run 005).
 */
import type { ComponentProps } from 'react'
import type { FilterRow, FilterToggles } from './index.tsx'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

export type FilterTogglesOnToggleIsTyped = Expect<Equal<ComponentProps<typeof FilterToggles>['onToggle'], (id: string, pressed: boolean) => void>>
export type FilterRowOnSelectIsTyped = Expect<Equal<ComponentProps<typeof FilterRow>['onSelect'], (id: string) => void>>
