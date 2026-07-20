# @mdbase/tasknotes

Portable TaskNotes task semantics for MDBASE Connect clients. The adapter reads
the collection's `tasknotes.task` contract, follows its field-role mapping, and
performs revision-safe generic mdbase operations. It does not assume fixed
frontmatter property names.
