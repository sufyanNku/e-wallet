-- Regenerate cached local collectible metadata after the artwork update.
-- Balances, ownership, transactions and remote metadata are unaffected.
DELETE FROM metadata_cache WHERE source = 'local-fixture';
