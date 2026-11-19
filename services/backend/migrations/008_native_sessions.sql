ALTER TABLE sessions ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'browser' CHECK (client_kind IN ('browser', 'native'));
