/**
 * The rollback primitive every delete path is built on.
 *
 * A cascade is expressed as ordered steps. Each step's `run()` returns an undo
 * function (or nothing when the step has no side effect). If a later step
 * throws, the completed steps are undone in REVERSE order; every undo failure
 * is collected instead of aborting the rollback, so one broken undo cannot stop
 * the remaining recoveries.
 *
 * The result is deliberately data, not an exception: callers decide how to
 * report a partially rolled-back transaction, and tests can assert step order
 * and undo order without catching exceptions.
 */

/**
 * @param {Array<{ name: string, run: () => Promise<(() => Promise<void>) | void> }>} steps
 * @param {{ onStep?: (name: string) => void }} [options]
 * @returns {Promise<
 *   { ok: true, completed: string[] } |
 *   { ok: false, failedStep: string, error: unknown, rolledBack: boolean,
 *     rollbackErrors: Array<{ step: string, error: unknown }> }
 * >}
 */
export async function runSteps(steps, options = {}) {
  /** @type {Array<{ name: string, undo: () => Promise<void> }>} */
  const completed = []

  for (const step of steps) {
    if (typeof step?.run !== 'function') {
      return {
        ok: false,
        failedStep: step?.name ?? 'unknown',
        error: new Error(`step "${step?.name ?? 'unknown'}" has no run()`),
        rolledBack: completed.length === 0,
        rollbackErrors: [],
      }
    }
    if (typeof options.onStep === 'function') options.onStep(step.name)

    let undo
    try {
      undo = await step.run()
    } catch (error) {
      const rollbackErrors = []
      for (const done of completed.reverse()) {
        if (done.undo === null) continue
        try {
          await done.undo()
        } catch (rollbackError) {
          rollbackErrors.push({ step: done.name, error: rollbackError })
        }
      }
      return {
        ok: false,
        failedStep: step.name,
        error,
        rolledBack: rollbackErrors.length === 0,
        rollbackErrors,
      }
    }
    if (typeof undo === 'function') completed.push({ name: step.name, undo })
    else completed.push({ name: step.name, undo: null })
  }

  return { ok: true, completed: completed.map((item) => item.name) }
}
