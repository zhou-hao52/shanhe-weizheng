CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  username VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  nickname VARCHAR(96) NOT NULL,
  password_hash VARCHAR(255) CHARACTER SET ascii NOT NULL,
  created_at VARCHAR(24) CHARACTER SET ascii NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  disabled_at VARCHAR(24) CHARACTER SET ascii,
  disabled_reason VARCHAR(160)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX sessions_user (user_id),
  INDEX sessions_expiry (expires_at),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  actor VARCHAR(32) NOT NULL,
  created_at VARCHAR(24) CHARACTER SET ascii NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX admin_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor VARCHAR(32) NOT NULL,
  action VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  result VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  detail VARCHAR(255),
  created_at VARCHAR(24) CHARACTER SET ascii NOT NULL,
  INDEX admin_audit_created (created_at),
  INDEX admin_audit_actor (actor, created_at),
  INDEX admin_audit_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS progress (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  visited_json JSON NOT NULL,
  favorites_json JSON NOT NULL,
  quiz_json JSON NOT NULL,
  last_node VARCHAR(6) CHARACTER SET ascii,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at VARCHAR(24) CHARACTER SET ascii NOT NULL,
  CONSTRAINT progress_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
