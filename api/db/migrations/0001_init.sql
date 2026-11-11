-- 0001_init: core schema (auth, profiles, library, community)
-- Forward-only. Runs inside a transaction: no BEGIN/COMMIT in this file.

CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive email/username
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- fuzzy book search

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- ── Auth ─────────────────────────────────────────────────────────────────────

CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email             citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
    password_hash     text NOT NULL,                 -- argon2id string (salt embedded)
    role              text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
    email_verified_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,                     -- sha256 of the cookie token
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ── Profiles ─────────────────────────────────────────────────────────────────

CREATE TABLE profiles (
    user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username     citext NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_]{3,20}$'),
    display_name text CHECK (char_length(display_name) <= 50),
    avatar_url   text CHECK (char_length(avatar_url) <= 500),
    banner_url   text CHECK (char_length(banner_url) <= 500),
    bio          text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 300),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Library ──────────────────────────────────────────────────────────────────
-- books = shared catalog. shelf_entries = one user's state for one book.

CREATE TABLE books (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
    author         text NOT NULL DEFAULT '' CHECK (char_length(author) <= 255),
    category       text NOT NULL DEFAULT '' CHECK (char_length(category) <= 255),
    total_chapters integer NOT NULL DEFAULT 0 CHECK (total_chapters >= 0),
    cover_url      text CHECK (char_length(cover_url) <= 500),
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX books_title_author_uq ON books (lower(title), lower(author));
CREATE INDEX books_title_trgm_idx  ON books USING gin (title  gin_trgm_ops);
CREATE INDEX books_author_trgm_idx ON books USING gin (author gin_trgm_ops);

CREATE TABLE shelf_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id         uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'to-read'
                    CHECK (status IN ('reading', 'completed', 'to-read', 'on-hold', 'dropped')),
    current_chapter integer NOT NULL DEFAULT 0 CHECK (current_chapter >= 0),
    rating          smallint NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
    notes           text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, book_id)
);
CREATE INDEX shelf_entries_user_status_idx ON shelf_entries (user_id, status);
CREATE INDEX shelf_entries_book_idx        ON shelf_entries (book_id);

-- ── Community ────────────────────────────────────────────────────────────────

CREATE TABLE threads (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    book_id    uuid REFERENCES books(id) ON DELETE SET NULL,   -- NULL = general discussion
    title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
-- keyset pagination: ORDER BY created_at DESC, id DESC
CREATE INDEX threads_feed_idx   ON threads (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX threads_book_idx   ON threads (book_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX threads_author_idx ON threads (author_id, created_at DESC);

CREATE TABLE comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id  uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    parent_id  uuid,
    author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,                                    -- soft delete keeps reply chains intact
    UNIQUE (id, thread_id),
    -- a reply must live in the same thread as its parent
    FOREIGN KEY (parent_id, thread_id) REFERENCES comments (id, thread_id) ON DELETE CASCADE
);
CREATE INDEX comments_thread_idx ON comments (thread_id, created_at, id);
CREATE INDEX comments_parent_idx ON comments (parent_id);
CREATE INDEX comments_author_idx ON comments (author_id, created_at DESC);

CREATE TABLE comment_votes (
    user_id    uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    value      smallint NOT NULL CHECK (value IN (-1, 1)),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, comment_id)
);
CREATE INDEX comment_votes_comment_idx ON comment_votes (comment_id);

CREATE TABLE follows (
    follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id);

-- ── Moderation ───────────────────────────────────────────────────────────────

CREATE TABLE reports (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('thread', 'comment', 'user')),
    target_id   uuid NOT NULL,
    reason      text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
    resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    resolved_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX reports_open_idx ON reports (created_at) WHERE status = 'open';

-- ── updated_at triggers ──────────────────────────────────────────────────────

CREATE TRIGGER users_updated_at         BEFORE UPDATE ON users         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER profiles_updated_at      BEFORE UPDATE ON profiles      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER books_updated_at         BEFORE UPDATE ON books         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER shelf_entries_updated_at BEFORE UPDATE ON shelf_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER threads_updated_at       BEFORE UPDATE ON threads       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER comments_updated_at      BEFORE UPDATE ON comments      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
