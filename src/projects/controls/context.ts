import { createContext, useContext } from 'react'
import type { DialogPreset } from './model.ts'
import type { Control } from './types.ts'

/** What the dock's command block needs to put a Run button on its first command; absent outside the live dock and while controls are off or unpaired. */
export type StepControls = {
  /** The control the step's command runs, when this browser is paired and the server offers it now. */
  forStep: (text: string) => { control: Control; preset: DialogPreset } | null
  run: (control: Control, preset: DialogPreset) => void
}

export const StepControlsContext = createContext<StepControls | null>(null)

export function useStepControls(): StepControls | null {
  return useContext(StepControlsContext)
}

/** The caption under a command block whose first command can run here; the unpaired page keeps today's. */
export const RUN_HERE_CAPTION = 'Run it here, or in your terminal.'
