'use strict';

/**
 * Persistence guard.
 *
 * A use case declares `requiresPersistence` when its behaviour is meaningless
 * without a database. medication-adherence does: inbound context ("the call
 * already knows") and resume-after-drop are entirely persistence features.
 *
 * Run against ConsoleRepository, such a use case does not fail — it succeeds
 * incorrectly. The agent greets a known caller as a stranger, resume finds
 * nothing to resume, and every log line looks healthy. A warning would be
 * functionally invisible: nobody tails stdout while listening to a phone call.
 *
 * So the check happens at boot, where it costs one restart instead of one demo.
 *
 * Capability is read from a flag on the repository rather than an instanceof
 * check, so core/ stays free of adapter imports.
 */

/**
 * Throw unless the use case's persistence requirement is met.
 *
 * @param {Object} useCase - { name, requiresPersistence }
 * @param {Object} repository - Any OutcomeRepositoryPort implementation
 * @throws {Error} Naming the use case and the variable that fixes it
 */
function assertPersistenceSatisfied(useCase, repository) {
  if (!useCase || !useCase.requiresPersistence) return;
  if (repository && repository.isPersistent) return;

  throw new Error(
    `Use case "${useCase.name}" requires persistence for inbound context and resume, ` +
      `but the active repository does not persist. ` +
      `Set DB_PATH (e.g. DB_PATH=./data/voiceagent.db) and restart.`
  );
}

module.exports = { assertPersistenceSatisfied };
