-- ============================================
-- TECH WAR — Complete Database Schema
-- Live Event Quiz Platform
-- ============================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- TEAMS
-- ============================================
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  join_code TEXT NOT NULL UNIQUE,
  coins INTEGER NOT NULL DEFAULT 1000,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ghost','eliminated')),
  ghost_target_id UUID REFERENCES teams(id),
  eliminated_after_round INTEGER,
  avg_response_time_ms FLOAT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teams_join_code ON teams(join_code);
CREATE INDEX IF NOT EXISTS idx_teams_coins ON teams(coins DESC);

-- ============================================
-- QUESTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id INTEGER NOT NULL CHECK (round_id BETWEEN 1 AND 5),
  theme TEXT,
  difficulty TEXT CHECK (difficulty IN ('easy','medium','hard')),
  question_text TEXT NOT NULL,
  options JSONB,
  correct_answer TEXT NOT NULL,
  coins_reward INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ANSWERS
-- ============================================
CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answer_given TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL,
  coins_earned INTEGER NOT NULL DEFAULT 0,
  time_elapsed_ms INTEGER,
  CONSTRAINT unique_team_question UNIQUE (team_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_team ON answers(team_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);

-- ============================================
-- GAME STATE (singleton row)
-- ============================================
CREATE TABLE IF NOT EXISTS game_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  current_round INTEGER DEFAULT 0,
  round_status TEXT DEFAULT 'waiting' CHECK (round_status IN ('waiting','active','paused','ended')),
  active_question_id UUID REFERENCES questions(id),
  question_opened_at TIMESTAMPTZ,
  is_paused BOOLEAN DEFAULT FALSE,
  r5_layers JSONB DEFAULT '[
    {"id":1,"status":"open","claimed_by":null,"breached_by":null,"claim_expires_at":null},
    {"id":2,"status":"open","claimed_by":null,"breached_by":null,"claim_expires_at":null},
    {"id":3,"status":"open","claimed_by":null,"breached_by":null,"claim_expires_at":null},
    {"id":4,"status":"open","claimed_by":null,"breached_by":null,"claim_expires_at":null},
    {"id":5,"status":"open","claimed_by":null,"breached_by":null,"claim_expires_at":null}
  ]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO game_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ============================================
-- POWER CARDS
-- ============================================
CREATE TABLE IF NOT EXISTS power_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id),
  card_type TEXT NOT NULL CHECK (card_type IN ('steal','shield','bounty')),
  acquired_via TEXT NOT NULL DEFAULT 'qr_scan',
  qr_scan_code TEXT,
  used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  target_team_id UUID REFERENCES teams(id),
  resolved BOOLEAN DEFAULT FALSE,
  coins_effect INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_card_per_type_per_team UNIQUE (team_id, card_type)
);

-- ============================================
-- MYSTERY BOXES
-- ============================================
CREATE TABLE IF NOT EXISTS mystery_boxes (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 15),
  box_type TEXT NOT NULL CHECK (box_type IN ('reward','bomb','challenge')),
  challenge_question TEXT,
  challenge_answer TEXT,
  revealed BOOLEAN DEFAULT FALSE,
  winner_team_id UUID REFERENCES teams(id),
  winning_bid INTEGER,
  opened_at TIMESTAMPTZ
);

-- ============================================
-- GHOST BETS
-- ============================================
CREATE TABLE IF NOT EXISTS ghost_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghost_team_id UUID NOT NULL REFERENCES teams(id),
  target_team_id UUID NOT NULL REFERENCES teams(id),
  locked_at TIMESTAMPTZ DEFAULT NOW(),
  coins_gained INTEGER DEFAULT 0,
  coins_lost INTEGER DEFAULT 0,
  CONSTRAINT one_ghost_bet UNIQUE (ghost_team_id)
);

-- ============================================
-- QR SCANS (Audit Log)
-- ============================================
CREATE TABLE IF NOT EXISTS qr_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id),
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  qr_payload TEXT NOT NULL,
  card_assigned TEXT NOT NULL,
  round_active INTEGER
);

-- ============================================
-- SEED: Mystery Boxes (4 reward, 4 bomb, 7 challenge)
-- ============================================
INSERT INTO mystery_boxes (id, box_type, challenge_question, challenge_answer) VALUES
  (1,  'reward',    NULL, NULL),
  (2,  'reward',    NULL, NULL),
  (3,  'reward',    NULL, NULL),
  (4,  'reward',    NULL, NULL),
  (5,  'bomb',      NULL, NULL),
  (6,  'bomb',      NULL, NULL),
  (7,  'bomb',      NULL, NULL),
  (8,  'bomb',      NULL, NULL),
  (9,  'challenge', 'What does HTTP stand for?', 'HyperText Transfer Protocol'),
  (10, 'challenge', 'What is the time complexity of binary search?', 'O(log n)'),
  (11, 'challenge', 'What port does HTTPS use by default?', '443'),
  (12, 'challenge', 'What does SQL stand for?', 'Structured Query Language'),
  (13, 'challenge', 'What is the output of typeof null in JavaScript?', 'object'),
  (14, 'challenge', 'What does DNS stand for?', 'Domain Name System'),
  (15, 'challenge', 'In CSS, what does the z-index property control?', 'stacking order')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- SEED: Sample Questions (Round 1 - Speed Quiz)
-- ============================================
INSERT INTO questions (round_id, theme, difficulty, question_text, options, correct_answer, coins_reward) VALUES
  (1, 'programming', 'easy', 'Which keyword is used to declare a variable in JavaScript (ES6)?', '["var","let","both","None"]', 'both', 50),
  (1, 'programming', 'easy', 'What does HTML stand for?', '["Hyper Trainer Marking Language","Hyper Text Markup Language","Hyper Text Marketing Language","Hyper Text Markup Leveler"]', 'Hyper Text Markup Language', 50),
  (1, 'programming', 'easy', 'Which symbol is used for single-line comments in JavaScript?', '["//","#","--","/* */"]', '//', 50),
  (1, 'programming', 'medium', 'What is the output of: console.log(typeof NaN)?', '["NaN","undefined","number","object"]', 'number', 50),
  (1, 'programming', 'medium', 'Which HTTP method is idempotent?', '["POST","PUT","PATCH","None"]', 'PUT', 50),
  (1, 'ai', 'easy', 'What does AI stand for?', '["Automated Intelligence","Artificial Intelligence","Advanced Integration","Augmented Interface"]', 'Artificial Intelligence', 50),
  (1, 'ai', 'medium', 'Which type of neural network is best suited for image recognition?', '["RNN","CNN","GAN","Transformer"]', 'CNN', 50),
  (1, 'ai', 'medium', 'What is the process of training a model on labeled data called?', '["Unsupervised Learning","Reinforcement Learning","Supervised Learning","Transfer Learning"]', 'Supervised Learning', 50),
  (1, 'cybersecurity', 'easy', 'What does VPN stand for?', '["Virtual Private Network","Virtual Protocol Network","Verified Private Network","Visual Private Node"]', 'Virtual Private Network', 50),
  (1, 'cybersecurity', 'medium', 'Which attack involves sending excessive requests to overwhelm a server?', '["Phishing","DDoS","SQL Injection","XSS"]', 'DDoS', 50),
  (1, 'logic', 'easy', 'What is the binary representation of the decimal number 10?', '["1010","1100","1001","1110"]', '1010', 50),
  (1, 'logic', 'medium', 'In Big O notation, what is the complexity of a nested loop iterating over an array of n elements?', '["O(n)","O(n^2)","O(log n)","O(n log n)"]', 'O(n^2)', 50),
  (1, 'programming', 'hard', 'What will console.log(0.1 + 0.2 === 0.3) output?', '["true","false","undefined","TypeError"]', 'false', 50),
  (1, 'ai', 'hard', 'What activation function outputs values between -1 and 1?', '["ReLU","Sigmoid","Tanh","Softmax"]', 'Tanh', 50),
  (1, 'cybersecurity', 'hard', 'What type of encryption uses the same key for encryption and decryption?', '["Asymmetric","Symmetric","Hashing","Hybrid"]', 'Symmetric', 50)
ON CONFLICT DO NOTHING;

-- SEED: Sample Questions (Round 2 - Multi-Set Strategy)
INSERT INTO questions (round_id, theme, difficulty, question_text, options, correct_answer, coins_reward) VALUES
  (2, 'programming', 'easy', 'What does CSS stand for?', '["Computer Style Sheets","Creative Style Sheets","Cascading Style Sheets","Colorful Style Sheets"]', 'Cascading Style Sheets', 100),
  (2, 'programming', 'medium', 'Which data structure uses FIFO (First In, First Out)?', '["Stack","Queue","Tree","Graph"]', 'Queue', 200),
  (2, 'programming', 'hard', 'What is the time complexity of quicksort in the average case?', '["O(n)","O(n log n)","O(n^2)","O(log n)"]', 'O(n log n)', 300),
  (2, 'ai', 'easy', 'What is the goal of Natural Language Processing (NLP)?', '["Image recognition","Understanding human language","Database management","Network security"]', 'Understanding human language', 100),
  (2, 'ai', 'medium', 'Which algorithm is commonly used for recommendation systems?', '["K-Means","Collaborative Filtering","Linear Regression","Decision Tree"]', 'Collaborative Filtering', 200),
  (2, 'ai', 'hard', 'What is the vanishing gradient problem?', '["Gradients become too large","Gradients approach zero","Model overfits","Data becomes corrupted"]', 'Gradients approach zero', 300),
  (2, 'cybersecurity', 'easy', 'What is phishing?', '["A type of malware","A social engineering attack via fake emails","A network protocol","A firewall rule"]', 'A social engineering attack via fake emails', 100),
  (2, 'cybersecurity', 'medium', 'What does OWASP stand for?', '["Open Web Application Security Project","Online Web App Safety Protocol","Open Wireless Application Security Program","Operational Web Attack Surface Platform"]', 'Open Web Application Security Project', 200),
  (2, 'cybersecurity', 'hard', 'What is a zero-day vulnerability?', '["A known patched bug","An exploit unknown to the vendor","A DDoS attack","A brute force method"]', 'An exploit unknown to the vendor', 300),
  (2, 'logic', 'easy', 'How many bits are in a byte?', '["4","6","8","16"]', '8', 100),
  (2, 'logic', 'medium', 'What sorting algorithm has the best worst-case time complexity?', '["Bubble Sort","Quick Sort","Merge Sort","Selection Sort"]', 'Merge Sort', 200),
  (2, 'logic', 'hard', 'What is the maximum number of edges in a simple undirected graph with n vertices?', '["n","n-1","n(n-1)/2","n^2"]', 'n(n-1)/2', 300)
ON CONFLICT DO NOTHING;

-- SEED: Sample Questions (Round 3 - Steal/Shield)
INSERT INTO questions (round_id, theme, difficulty, question_text, options, correct_answer, coins_reward) VALUES
  (3, 'programming', 'medium', 'What is a closure in JavaScript?', '["A way to close browser tabs","A function with access to its outer scope","A CSS property","A type of loop"]', 'A function with access to its outer scope', 100),
  (3, 'programming', 'medium', 'What does REST stand for?', '["Representational State Transfer","Remote Execution Standard Technology","Realtime Event Stream Transfer","Recursive State Transformation"]', 'Representational State Transfer', 100),
  (3, 'ai', 'medium', 'What is overfitting?', '["Model performs well on training data but poorly on new data","Model is too simple","Model trains too slowly","Model uses too little data"]', 'Model performs well on training data but poorly on new data', 100),
  (3, 'cybersecurity', 'medium', 'What is SQL injection?', '["A database backup method","Inserting malicious SQL via user input","A type of encryption","A firewall configuration"]', 'Inserting malicious SQL via user input', 100),
  (3, 'logic', 'hard', 'What is the output of: !!""', '["true","false","undefined","null"]', 'false', 100),
  (3, 'programming', 'hard', 'What is the difference between == and === in JavaScript?', '["No difference","=== checks type and value","== is assignment","=== is faster"]', '=== checks type and value', 100),
  (3, 'ai', 'hard', 'What is backpropagation?', '["Forward data flow","Algorithm to update weights by computing gradients","A data preprocessing step","A type of neural network"]', 'Algorithm to update weights by computing gradients', 100),
  (3, 'cybersecurity', 'hard', 'What does XSS stand for?', '["Extra Small Styling","Cross-Site Scripting","Cross-Server Sync","Extended Security Schema"]', 'Cross-Site Scripting', 100)
ON CONFLICT DO NOTHING;

-- SEED: Round 5 questions (open-ended, no options)
INSERT INTO questions (round_id, theme, difficulty, question_text, options, correct_answer, coins_reward) VALUES
  (5, 'programming', 'hard', 'What command is used to initialize a new Git repository?', NULL, 'git init', 0),
  (5, 'cybersecurity', 'hard', 'What is the default port for SSH?', NULL, '22', 0),
  (5, 'ai', 'hard', 'Name the Python library most commonly used for deep learning by Facebook/Meta.', NULL, 'pytorch', 0),
  (5, 'logic', 'hard', 'What is the hexadecimal representation of the decimal number 255?', NULL, 'ff', 0),
  (5, 'programming', 'hard', 'What does the acronym API stand for?', NULL, 'application programming interface', 0)
ON CONFLICT DO NOTHING;

-- SEED: Sample team join codes (for testing)
INSERT INTO teams (name, join_code) VALUES
  ('Team Alpha', 'ABC123'),
  ('Team Beta', 'DEF456'),
  ('Team Gamma', 'GHI789'),
  ('Team Delta', 'JKL012'),
  ('Team Epsilon','MNO345')
ON CONFLICT DO NOTHING;
