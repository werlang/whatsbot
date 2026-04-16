CREATE TABLE IF NOT EXISTS scheduled_messages (
    id CHAR(36) NOT NULL PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL DEFAULT 'main',
    target_type ENUM("contact", "group") NOT NULL DEFAULT "contact",
    target_value VARCHAR(128) NOT NULL,
    phone_number VARCHAR(32) DEFAULT NULL,
    message TEXT NOT NULL,
    scheduled_for DATETIME NOT NULL,
    status ENUM("pending", "processing", "sent", "failed") NOT NULL DEFAULT "pending",
    claim_token CHAR(36) DEFAULT NULL,
    claimed_at DATETIME DEFAULT NULL,
    last_attempt_at DATETIME DEFAULT NULL,
    sent_at DATETIME DEFAULT NULL,
    whatsapp_chat_id VARCHAR(64) DEFAULT NULL,
    whatsapp_message_id VARCHAR(128) DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_scheduled_messages_target (session_id, target_type, target_value),
    INDEX idx_scheduled_messages_due (status, scheduled_for),
    INDEX idx_scheduled_messages_claim_token (claim_token)
);

CREATE TABLE IF NOT EXISTS whatsapp_session_access (
    session_id VARCHAR(64) NOT NULL PRIMARY KEY,
    access_token_hash CHAR(64) NOT NULL,
    recovery_password_hash CHAR(64) NOT NULL,
    recovery_password_salt CHAR(32) NOT NULL,
    recovery_password_lookup CHAR(64) NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uk_whatsapp_session_access_token_hash (access_token_hash),
    UNIQUE KEY uk_whatsapp_session_access_recovery_lookup (recovery_password_lookup)
);
