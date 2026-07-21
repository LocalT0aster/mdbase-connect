# @mdbase/tasknotes

Portable TaskNotes task semantics for mdbase connect clients. The adapter reads
the collection's `tasknotes.task` contract, follows its field-role mapping, and
performs revision-safe generic mdbase operations. It does not assume fixed
frontmatter property names.

`TasknotesOfflineCollection` provides the same contract-aware create, list, and
completion operations over an `@mdbase/connect-sync` offline replica. Local
changes appear immediately and retain their durable mutation IDs when the
replica later synchronizes with a hosted authority.
