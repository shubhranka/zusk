//! Splits a SQL script into statements the way psql does, so each statement
//! can be sent on its own. Knowing statement boundaries lets us map Postgres
//! error positions back into the editor, enforce read-only mode per statement
//! and track transaction state.
//!
//! Handles quoted strings ('…', E'…'), quoted identifiers ("…"), dollar
//! quoting ($tag$…$tag$), line and nested block comments, parentheses, and the
//! BEGIN ATOMIC … END bodies of SQL-standard functions.

/// One statement inside a script. `start..end` is a byte range into the
/// script, trimmed of surrounding whitespace/comments and the trailing `;`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub start: usize,
    pub end: usize,
    /// The leading words of the statement, upper-cased (at most six).
    /// Empty when the statement starts with something other than a word.
    pub keywords: Vec<String>,
}

impl Statement {
    pub fn text<'a>(&self, sql: &'a str) -> &'a str {
        &sql[self.start..self.end]
    }

    fn word(&self, i: usize) -> &str {
        self.keywords.get(i).map(String::as_str).unwrap_or("")
    }

    fn has_word(&self, w: &str) -> bool {
        self.keywords.iter().any(|k| k == w)
    }

    /// The command name shown in the UI, e.g. "SELECT" or "CREATE TABLE".
    pub fn command(&self) -> String {
        match self.word(0) {
            "" => "QUERY".to_owned(),
            "CREATE" | "DROP" | "ALTER" => {
                let mut parts = vec![self.word(0)];
                for w in self.keywords.iter().skip(1) {
                    match w.as_str() {
                        "OR" | "REPLACE" | "TEMP" | "TEMPORARY" | "UNLOGGED" | "UNIQUE" | "MATERIALIZED" | "IF" | "NOT" | "EXISTS" => continue,
                        other => {
                            parts.push(other);
                            break;
                        }
                    }
                }
                parts.join(" ")
            }
            w => w.to_owned(),
        }
    }

    /// If this statement ends or starts a transaction, returns its command
    /// word. Such statements are refused in read-only mode because they would
    /// end the read-only transaction each run is wrapped in.
    pub fn transaction_control(&self) -> Option<&str> {
        match self.word(0) {
            w @ ("COMMIT" | "END" | "ABORT" | "BEGIN" | "START") => Some(w),
            // ROLLBACK [WORK|TRANSACTION] TO SAVEPOINT stays inside the transaction.
            "ROLLBACK" if !self.has_word("TO") => Some("ROLLBACK"),
            "PREPARE" if self.word(1) == "TRANSACTION" => Some("PREPARE TRANSACTION"),
            _ => None,
        }
    }

    /// How this statement changes the session's transaction state.
    pub fn tx_effect(&self) -> TxEffect {
        let chain = self.has_word("CHAIN") && !self.has_word("NO");
        match self.word(0) {
            "BEGIN" | "START" => TxEffect::Begin,
            "COMMIT" | "ROLLBACK" if self.word(1) == "PREPARED" => TxEffect::None,
            "ROLLBACK" if self.has_word("TO") => TxEffect::RollbackToSavepoint,
            "COMMIT" | "END" | "ROLLBACK" | "ABORT" if chain => TxEffect::Begin,
            "COMMIT" | "END" | "ROLLBACK" | "ABORT" => TxEffect::End,
            "PREPARE" if self.word(1) == "TRANSACTION" => TxEffect::End,
            _ => TxEffect::None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxEffect {
    None,
    Begin,
    End,
    RollbackToSavepoint,
}

fn is_word_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b >= 0x80
}

fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

#[derive(Default)]
struct Current {
    start: Option<usize>,
    end: usize,
    keywords: Vec<String>,
    leading_words_only: bool,
    word_count: usize,
    /// First letters of the leading CREATE/OR/REPLACE/FUNCTION/PROCEDURE words,
    /// mirroring psql's heuristic for detecting routine definitions.
    head: [u8; 4],
    paren_depth: i32,
    begin_depth: i32,
}

impl Current {
    fn new() -> Self {
        Current { leading_words_only: true, ..Default::default() }
    }

    fn touch(&mut self, from: usize, to: usize) {
        if self.start.is_none() {
            self.start = Some(from);
        }
        self.end = to;
    }

    fn non_word_token(&mut self, from: usize, to: usize) {
        self.touch(from, to);
        self.leading_words_only = false;
    }

    fn word(&mut self, word: &str, from: usize, to: usize) {
        self.touch(from, to);
        let upper = word.to_ascii_uppercase();

        if self.word_count < self.head.len() && matches!(upper.as_str(), "CREATE" | "OR" | "REPLACE" | "FUNCTION" | "PROCEDURE") {
            self.head[self.word_count] = upper.as_bytes()[0];
        }
        self.word_count += 1;

        let h = self.head;
        let is_routine = h[0] == b'C' && (h[1] == b'F' || h[1] == b'P' || (h[1] == b'O' && h[2] == b'R' && (h[3] == b'F' || h[3] == b'P')));
        if is_routine && self.paren_depth == 0 {
            match upper.as_str() {
                "BEGIN" => self.begin_depth += 1,
                "CASE" if self.begin_depth >= 1 => self.begin_depth += 1,
                "END" if self.begin_depth > 0 => self.begin_depth -= 1,
                _ => {}
            }
        }

        if self.leading_words_only && self.keywords.len() < 6 {
            self.keywords.push(upper);
        }
    }

    fn finish(self, out: &mut Vec<Statement>) {
        if let Some(start) = self.start {
            out.push(Statement { start, end: self.end, keywords: self.keywords });
        }
    }
}

/// Splits `sql` into non-empty statements.
pub fn split(sql: &str) -> Vec<Statement> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut cur = Current::new();
    let mut i = 0;

    while i < n {
        let c = b[i];
        match c {
            _ if c.is_ascii_whitespace() => i += 1,

            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }

            b'/' if b.get(i + 1) == Some(&b'*') => {
                let mut depth = 1;
                i += 2;
                while i < n && depth > 0 {
                    if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                        depth += 1;
                        i += 2;
                    } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }

            b'\'' => {
                let start = i;
                i = skip_string(b, i, false);
                cur.non_word_token(start, i);
            }

            b'"' => {
                let start = i;
                i += 1;
                while i < n {
                    if b[i] == b'"' {
                        if b.get(i + 1) == Some(&b'"') {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                // A quoted identifier is still an identifier, but never a keyword.
                cur.non_word_token(start, i);
            }

            b'$' => {
                let start = i;
                if let Some(tag_end) = dollar_tag_end(b, i) {
                    let tag = &b[i..=tag_end];
                    i = tag_end + 1;
                    // Find the matching closing tag; unterminated quotes run to the end.
                    loop {
                        if i >= n {
                            break;
                        }
                        if b[i] == b'$' && b[i..].starts_with(tag) {
                            i += tag.len();
                            break;
                        }
                        i += 1;
                    }
                } else {
                    // `$1` parameter or a stray `$`.
                    i += 1;
                    while i < n && b[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                cur.non_word_token(start, i);
            }

            _ if is_word_start(c) => {
                let start = i;
                while i < n && is_word_char(b[i]) {
                    i += 1;
                }
                let word = &sql[start..i];
                // E'…' escape string: backslashes escape the next character.
                if (word == "E" || word == "e") && b.get(i) == Some(&b'\'') {
                    i = skip_string(b, i, true);
                    cur.non_word_token(start, i);
                } else {
                    cur.word(word, start, i);
                }
            }

            b'(' => {
                cur.paren_depth += 1;
                cur.non_word_token(i, i + 1);
                i += 1;
            }

            b')' => {
                cur.paren_depth = (cur.paren_depth - 1).max(0);
                cur.non_word_token(i, i + 1);
                i += 1;
            }

            b';' if cur.paren_depth == 0 && cur.begin_depth == 0 => {
                std::mem::replace(&mut cur, Current::new()).finish(&mut out);
                i += 1;
            }

            _ => {
                // Any other byte (operators, digits, a `;` nested in a routine
                // body, the remainder of a multi-byte character, …).
                let start = i;
                i += 1;
                cur.non_word_token(start, i);
            }
        }
    }
    cur.finish(&mut out);
    out
}

/// Skips a single-quoted string starting at `i` (which must point at `'`),
/// returning the index just past it. `escapes` enables backslash escapes.
fn skip_string(b: &[u8], mut i: usize, escapes: bool) -> usize {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' if escapes => i += 2,
            b'\'' if b.get(i + 1) == Some(&b'\'') => i += 2,
            b'\'' => return i + 1,
            _ => i += 1,
        }
    }
    b.len()
}

/// If a dollar-quote opening tag starts at `i`, returns the index of its closing `$`.
fn dollar_tag_end(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if j < b.len() && b[j] == b'$' {
        return Some(j);
    }
    if j >= b.len() || !is_word_start(b[j]) {
        return None;
    }
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] >= 0x80) {
        j += 1;
    }
    (j < b.len() && b[j] == b'$').then_some(j)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str) -> Vec<&str> {
        split(sql).iter().map(|s| s.text(sql)).collect()
    }

    #[test]
    fn splits_simple_statements() {
        assert_eq!(texts("select 1; select 2;"), vec!["select 1", "select 2"]);
        assert_eq!(texts("  select 1  \n"), vec!["select 1"]);
    }

    #[test]
    fn skips_empty_and_comment_only_statements() {
        assert_eq!(texts(";; -- nothing\n ; /* still nothing */"), Vec::<&str>::new());
        assert_eq!(texts("-- lead\nselect 1 -- trail\n;"), vec!["select 1"]);
    }

    #[test]
    fn ignores_semicolons_in_quotes_and_comments() {
        let sql = "select ';', \"a;b\", $$;$$, $fn$ x; $$ $fn$ /* ; /* nested ; */ */ -- ;\n; select 2";
        assert_eq!(split(sql).len(), 2);
        assert_eq!(texts("select E'it\\'s;'; select 2").len(), 2);
        assert_eq!(texts("select 'it''s;'; select 2").len(), 2);
    }

    #[test]
    fn handles_params_and_identifiers_with_dollars() {
        assert_eq!(texts("select $1; select a$b$ from t; select 3").len(), 3);
    }

    #[test]
    fn keeps_begin_atomic_bodies_together() {
        let sql = "create or replace function f() returns int language sql begin atomic select 1; select case when true then 2 end; end; select 3";
        assert_eq!(texts(sql).len(), 2);
        let sql = "create procedure p() begin atomic insert into t values (1); end; select 1";
        assert_eq!(texts(sql).len(), 2);
    }

    #[test]
    fn keeps_parenthesised_semicolons_together() {
        assert_eq!(texts("create rule r as on insert to t do also (insert into a values (1); insert into b values (2)); select 1").len(), 2);
    }

    #[test]
    fn collects_leading_keywords() {
        let s = &split("  rollback  to savepoint a")[0];
        assert_eq!(s.keywords, vec!["ROLLBACK", "TO", "SAVEPOINT", "A"]);
        assert_eq!(split("(select 1)")[0].keywords, Vec::<String>::new());
        assert_eq!(split("select * from t")[0].keywords, vec!["SELECT"]);
    }

    #[test]
    fn detects_transaction_control() {
        let tc = |s: &str| split(s)[0].transaction_control().map(str::to_owned);
        assert_eq!(tc("COMMIT"), Some("COMMIT".into()));
        assert_eq!(tc("end"), Some("END".into()));
        assert_eq!(tc("rollback"), Some("ROLLBACK".into()));
        assert_eq!(tc("rollback to savepoint x"), None);
        assert_eq!(tc("rollback work to x"), None);
        assert_eq!(tc("begin isolation level serializable"), Some("BEGIN".into()));
        assert_eq!(tc("start transaction"), Some("START".into()));
        assert_eq!(tc("prepare transaction 'x'"), Some("PREPARE TRANSACTION".into()));
        assert_eq!(tc("prepare q as select 1"), None);
        assert_eq!(tc("select 'commit'"), None);
        assert_eq!(tc("/* x */ commit"), Some("COMMIT".into()));
    }

    #[test]
    fn tracks_transaction_effects() {
        let fx = |s: &str| split(s)[0].tx_effect();
        assert_eq!(fx("begin"), TxEffect::Begin);
        assert_eq!(fx("commit"), TxEffect::End);
        assert_eq!(fx("commit and chain"), TxEffect::Begin);
        assert_eq!(fx("commit and no chain"), TxEffect::End);
        assert_eq!(fx("rollback to savepoint s"), TxEffect::RollbackToSavepoint);
        assert_eq!(fx("commit prepared 'x'"), TxEffect::None);
        assert_eq!(fx("update t set a = 1"), TxEffect::None);
    }

    #[test]
    fn names_commands() {
        assert_eq!(split("create or replace temp view v as select 1")[0].command(), "CREATE VIEW");
        assert_eq!(split("drop table if exists t")[0].command(), "DROP TABLE");
        assert_eq!(split("update t set a = 1")[0].command(), "UPDATE");
        assert_eq!(split("(select 1)")[0].command(), "QUERY");
    }

    #[test]
    fn handles_multibyte_text() {
        let sql = "select 'Álvarez; ✓'; select '😀'";
        assert_eq!(texts(sql), vec!["select 'Álvarez; ✓'", "select '😀'"]);
    }

    #[test]
    fn unterminated_quotes_run_to_the_end() {
        assert_eq!(texts("select 'abc; select 2").len(), 1);
        assert_eq!(texts("select $$abc; select 2").len(), 1);
    }
}
