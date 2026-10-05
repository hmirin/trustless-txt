CREATE TABLE rate_limits (
  client TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (client, window_start)
);
