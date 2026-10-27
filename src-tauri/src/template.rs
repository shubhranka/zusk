//! Jinja templating for the editor, in the dialect of Apache Superset's SQL
//! Lab: `{{ from_dttm }}`, `{{ to_dttm }}`, `filter_values('col')`,
//! `get_filters('col')`, `url_param('name')` and the `where_in` filter, all
//! fed from one JSON object of variables. The output is plain SQL, which then
//! runs like anything typed by hand.

use std::collections::BTreeMap;
use std::sync::Arc;

use minijinja::value::{Kwargs, Value};
use minijinja::{AutoEscape, Environment};
use serde::Serialize;
use serde_json::{Map, Value as Json};

use crate::error::{AppError, AppResult, ErrorKind};

/// One filter, shaped like Superset's `get_filters()` items.
#[derive(Debug, Clone, Serialize)]
struct Filter {
    op: String,
    col: String,
    val: Json,
}

type Filters = BTreeMap<String, Vec<Filter>>;

/// Renders `sql` as a Jinja template.
///
/// `vars` is a JSON object. Every key becomes a template variable; two are
/// also read by the Superset macros:
///
/// - `filters`: column → `["a", "b"]` (op IN), a single value (op ==),
///   `{"op": "ILIKE", "val": "%a%"}`, or a list of such objects.
/// - `url_params`: name → value, for `url_param()`.
pub fn render(sql: &str, vars: &Json) -> AppResult<String> {
    let Json::Object(vars) = vars else {
        return Err(AppError::invalid("Template variables must be a JSON object."));
    };
    let filters = Arc::new(parse_filters(vars.get("filters"))?);
    let url_params = Arc::new(match vars.get("url_params") {
        None | Some(Json::Null) => Map::new(),
        Some(Json::Object(m)) => m.clone(),
        Some(_) => return Err(AppError::invalid("\"url_params\" must be a JSON object.")),
    });

    let mut env = Environment::new();
    // Keeps error spans, so the editor can underline the failing tag.
    env.set_debug(true);
    env.set_auto_escape_callback(|_| AutoEscape::None);
    env.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
    env.add_filter("where_in", where_in);

    let f = filters.clone();
    env.add_function(
        "filter_values",
        move |column: String, default: Option<Value>, _remove_filter: Option<bool>, kwargs: Kwargs| {
            let default = default.or(kwargs.get::<Option<Value>>("default")?);
            let _: Option<bool> = kwargs.get("remove_filter")?;
            kwargs.assert_all_used()?;
            let mut values = Vec::new();
            for flt in f.get(&column).into_iter().flatten() {
                match &flt.val {
                    Json::Array(items) => values.extend(items.iter().map(Value::from_serialize)),
                    val => values.push(Value::from_serialize(val)),
                }
            }
            if values.is_empty() {
                values.extend(default.filter(Value::is_true));
            }
            Ok::<_, minijinja::Error>(Value::from(values))
        },
    );

    let f = filters.clone();
    env.add_function("get_filters", move |column: String, _remove_filter: Option<bool>, kwargs: Kwargs| {
        let _: Option<bool> = kwargs.get("remove_filter")?;
        kwargs.assert_all_used()?;
        Ok::<_, minijinja::Error>(Value::from_serialize(f.get(&column).map(Vec::as_slice).unwrap_or_default()))
    });

    env.add_function("url_param", move |param: String, default: Option<Value>, kwargs: Kwargs| {
        let default = default.or(kwargs.get::<Option<Value>>("default")?);
        let _: Option<bool> = kwargs.get("add_to_cache_keys")?;
        let escape: Option<bool> = kwargs.get("escape_result")?;
        kwargs.assert_all_used()?;
        Ok::<_, minijinja::Error>(match url_params.get(&param) {
            // Superset escapes for a string literal: ' becomes ''.
            Some(Json::String(s)) if escape.unwrap_or(true) => Value::from(s.replace('\'', "''")),
            Some(value) => Value::from_serialize(value),
            None => default.unwrap_or_default(),
        })
    });

    // Superset always defines these, as None when there is no time range.
    let mut context: BTreeMap<String, Value> = BTreeMap::new();
    context.insert("from_dttm".into(), Value::from(()));
    context.insert("to_dttm".into(), Value::from(()));
    for (key, value) in vars {
        context.insert(key.clone(), Value::from_serialize(value));
    }

    env.render_str(sql, context).map_err(|e| template_error(sql, &e))
}

/// Normalises the `filters` object into Superset's `{op, col, val}` lists.
fn parse_filters(value: Option<&Json>) -> AppResult<Filters> {
    let map = match value {
        None | Some(Json::Null) => return Ok(Filters::new()),
        Some(Json::Object(map)) => map,
        Some(_) => return Err(AppError::invalid("\"filters\" must be a JSON object of column → values.")),
    };
    let mut out = Filters::new();
    for (col, spec) in map {
        let is_filter = |v: &Json| v.as_object().is_some_and(|o| o.contains_key("op"));
        let raw: Vec<(String, Json)> = match spec {
            Json::Array(items) if !items.is_empty() && items.iter().all(is_filter) => items.iter().map(|o| op_and_val(col, o)).collect::<AppResult<_>>()?,
            Json::Object(_) if is_filter(spec) => vec![op_and_val(col, spec)?],
            Json::Array(_) => vec![("IN".to_owned(), spec.clone())],
            Json::Object(_) => {
                return Err(AppError::invalid(format!("Filter \"{col}\" needs an \"op\", like {{\"op\": \"IN\", \"val\": [\"a\"]}}.")))
            }
            _ => vec![("==".to_owned(), spec.clone())],
        };
        // Like Superset, a filter with no value is not a filter.
        let filters: Vec<Filter> = raw
            .into_iter()
            .filter(|(_, val)| !matches!(val, Json::Null) && val.as_str() != Some("") && val.as_array().is_none_or(|a| !a.is_empty()))
            .map(|(op, val)| {
                let val = if matches!(op.as_str(), "IN" | "NOT IN") && !val.is_array() { Json::Array(vec![val]) } else { val };
                Filter { op, col: col.clone(), val }
            })
            .collect();
        if !filters.is_empty() {
            out.insert(col.clone(), filters);
        }
    }
    Ok(out)
}

fn op_and_val(col: &str, spec: &Json) -> AppResult<(String, Json)> {
    let op = spec
        .get("op")
        .and_then(Json::as_str)
        .ok_or_else(|| AppError::invalid(format!("Filter \"{col}\": \"op\" must be a string, like \"IN\" or \"ILIKE\".")))?;
    Ok((op.trim().to_uppercase(), spec.get("val").cloned().unwrap_or(Json::Null)))
}

/// `{{ ['a', 1] | where_in }}` → `('a', 1)`, quoting strings for SQL.
fn where_in(values: Value, mark: Option<String>, kwargs: Kwargs) -> Result<String, minijinja::Error> {
    let mark = mark.or(kwargs.get("mark")?).unwrap_or_else(|| "'".to_owned());
    kwargs.assert_all_used()?;
    let quote = |v: Value| match v.as_str() {
        Some(s) => format!("{mark}{}{mark}", s.replace(&mark, &mark.repeat(2))),
        None if v.is_none() || v.is_undefined() => "NULL".to_owned(),
        None => v.to_string(),
    };
    let items: Vec<String> = match values.try_iter() {
        Ok(iter) if values.as_str().is_none() => iter.map(quote).collect(),
        _ => vec![quote(values)],
    };
    Ok(format!("({})", items.join(", ")))
}

/// A Jinja error, with the failing part of the template as a UTF-16 range
/// (in `statement_range`) so the editor can underline it.
fn template_error(source: &str, err: &minijinja::Error) -> AppError {
    let kind = err.kind().to_string();
    let message = match err.detail() {
        Some(detail) => format!("{}: {detail}", capitalize(&kind)),
        None => capitalize(&kind),
    };
    let mut out = AppError::new(ErrorKind::Template, message);
    if err.kind() == minijinja::ErrorKind::UndefinedError {
        out.hint = Some("Something used here isn’t defined. Add it under Variables, or guard it with `is defined`.".to_owned());
    }
    let utf16 = |byte: usize| source.get(..byte).map(|s| s.chars().map(char::len_utf16).sum::<usize>());
    let span = err.range().filter(|r| r.end > r.start).or_else(|| {
        // No exact span: fall back to the whole line.
        let line = err.line()?;
        let start = source.split_inclusive('\n').take(line - 1).map(str::len).sum::<usize>();
        let end = source[start..].find('\n').map_or(source.len(), |i| start + i);
        Some(start..end)
    });
    if let Some(span) = span {
        if let (Some(from), Some(to)) = (utf16(span.start), utf16(span.end)) {
            out.statement_range = Some((from, to));
        }
    }
    if let Some(source) = std::error::Error::source(err) {
        out.detail = Some(source.to_string());
    }
    out
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn r(sql: &str, vars: Json) -> String {
        render(sql, &vars).unwrap_or_else(|e| panic!("render failed: {}", e.message))
    }

    #[test]
    fn plain_sql_is_unchanged() {
        let sql = "SELECT payload #> '{a,b}', '{x}'::text[] FROM t";
        assert_eq!(r(sql, json!({})), sql);
    }

    #[test]
    fn variables_and_time_range() {
        assert_eq!(r("{{ from_dttm }}|{{ to_dttm }}", json!({})), "None|None");
        assert_eq!(r("'{{ from_dttm }}'", json!({"from_dttm": "2024-01-01 00:00:00"})), "'2024-01-01 00:00:00'");
        assert_eq!(r("{{ limit }}", json!({"limit": 5})), "5");
    }

    #[test]
    fn filter_values_and_get_filters() {
        let vars = json!({"filters": {
            "a": ["x", "y"],
            "b": "one",
            "c": {"op": "ilike", "val": "%z%"},
            "d": [],
            "e": [{"op": "IN", "val": "solo"}, {"op": "NOT IN", "val": ["n"]}],
        }});
        assert_eq!(r("{{ filter_values('a') }}", vars.clone()), r#"["x", "y"]"#);
        assert_eq!(r("{{ filter_values('b') }}", vars.clone()), r#"["one"]"#);
        assert_eq!(r("{{ filter_values('d') }}", vars.clone()), "[]");
        assert_eq!(r("{{ filter_values('missing', 'dflt') }}", vars.clone()), r#"["dflt"]"#);
        assert_eq!(r("{{ filter_values('e', remove_filter=True) }}", vars.clone()), r#"["solo", "n"]"#);
        assert_eq!(
            r("{% for f in get_filters('c', remove_filter=True) %}{{ f['op'] }} {{ f.col }} {{ f['val'] }}{% endfor %}", vars.clone()),
            "ILIKE c %z%"
        );
        assert_eq!(r("{{ get_filters('a')[0].val | where_in }}", vars), "('x', 'y')");
    }

    #[test]
    fn where_in_quotes() {
        assert_eq!(r(r#"{{ ["it's", 2, none] | where_in }}"#, json!({})), "('it''s', 2, NULL)");
        assert_eq!(r("{{ 'one' | where_in }}", json!({})), "('one')");
        assert_eq!(r(r#"{{ ['a'] | where_in(mark='"') }}"#, json!({})), r#"("a")"#);
    }

    #[test]
    fn url_param_escapes() {
        let vars = json!({"url_params": {"name": "O'Brien", "n": 3}});
        assert_eq!(r("{{ url_param('name') }}", vars.clone()), "O''Brien");
        assert_eq!(r("{{ url_param('name', escape_result=False) }}", vars.clone()), "O'Brien");
        assert_eq!(r("{{ url_param('n') }}", vars.clone()), "3");
        assert_eq!(r("{{ url_param('nope', 'd') }}", vars), "d");
    }

    #[test]
    fn python_methods() {
        assert_eq!(r("{{ 'a,b'.split(',') | length }} {{ ' x '.strip() }} {{ m.get('k', 1) }}", json!({"m": {}})), "2 x 1");
    }

    #[test]
    fn superset_style_template() {
        // The shape of a real SQL Lab template: guards, cleaned filter lists, loops.
        let sql = r#"{% if from_dttm is not defined %}{% set from_dttm = '' %}{% endif %}
{% set from_ok = from_dttm|trim != '' and from_dttm|lower != 'none' %}
{% set prn_f = (filter_values('PRN') or []) | select('string') | map('trim') | reject('equalto','') | list %}
{% if not (from_ok or prn_f | length > 0) %}SELECT NULL LIMIT 1{% else %}SELECT * FROM t WHERE ts >= {% if from_ok %}'{{ from_dttm }}'{% else %}'1900-01-01'{% endif %}
{%- if prn_f %} AND prn IN ({% for v in prn_f %}'{{ v | replace("'", "''") }}'{% if not loop.last %}, {% endif %}{% endfor %}){% endif %}
{%- for f in get_filters('Stage', remove_filter=True) %}
  {%- if f['op'] == 'IN' and f['val'] %} AND stage IN {{ f['val'] | where_in }}
  {%- elif f['op'] in ('ILIKE','LIKE') and f['val'] %} AND strpos(lower(stage), lower('{{ f['val'] | replace('%','') }}')) > 0
  {%- endif %}
{%- endfor %}
{%- for f in get_filters('Final', remove_filter=True) %} AND final IN ({% for v in f['val'] %}{{ 'TRUE' if v|string|lower in ['yes','y'] else 'FALSE' }}{% if not loop.last %}, {% endif %}{% endfor %}){% endfor %}{% endif %}"#;

        assert_eq!(r(sql, json!({})).trim(), "SELECT NULL LIMIT 1");
        let out = r(
            sql,
            json!({"filters": {"PRN": [" A1 ", "", "O'K"], "Stage": {"op": "ILIKE", "val": "%wall%"}, "Final": ["Yes", "no"]}}),
        );
        assert_eq!(
            out.trim(),
            "SELECT * FROM t WHERE ts >= '1900-01-01' AND prn IN ('A1', 'O''K') AND strpos(lower(stage), lower('wall')) > 0 AND final IN (TRUE, FALSE)"
        );
        let out = r(sql, json!({"from_dttm": "2024-05-01T00:00:00", "filters": {"Stage": ["Removal"]}}));
        assert_eq!(out.trim(), "SELECT * FROM t WHERE ts >= '2024-05-01T00:00:00' AND stage IN ('Removal')");
    }

    #[test]
    fn errors_point_at_the_template() {
        let sql = "SELECT 1\nWHERE {{ nope( }}";
        let err = render(sql, &json!({})).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Template);
        let (from, to) = err.statement_range.expect("range");
        assert!(from >= 9 && to <= sql.len(), "{from}..{to}");

        let err = render("SELECT {{ unknown_fn() }}", &json!({})).unwrap_err();
        assert!(err.message.contains("unknown_fn"), "{}", err.message);

        let err = render("x", &json!({"filters": {"a": {"val": 1}}})).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
    }
}
