CREATE TABLE IF NOT EXISTS user_favorite_folders (
  user_id TEXT NOT NULL,
  folder_key TEXT NOT NULL CHECK (length(folder_key) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, folder_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
