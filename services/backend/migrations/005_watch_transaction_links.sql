CREATE TABLE watch_transactions (
 watch_id TEXT NOT NULL REFERENCES watched_accounts(id) ON DELETE CASCADE,
 network_id TEXT NOT NULL, tx_hash TEXT NOT NULL, event_index TEXT NOT NULL,
 direction TEXT NOT NULL,
 PRIMARY KEY(watch_id,network_id,tx_hash,event_index),
 FOREIGN KEY(network_id,tx_hash,event_index) REFERENCES transfers(network_id,tx_hash,event_index) ON DELETE CASCADE
);
CREATE TABLE watched_subaccounts (
 watch_id TEXT NOT NULL REFERENCES watched_accounts(id) ON DELETE CASCADE,
 address TEXT NOT NULL, kind TEXT NOT NULL, first_observed_at TEXT NOT NULL,
 PRIMARY KEY(watch_id,address)
);
