//! Catalog queries behind the explorer tree, the Structure tab and ⌘K.
//! Everything reads pg_catalog directly (faster than information_schema and
//! it also covers materialized views, row estimates and sizes).

use serde::Serialize;
use tokio_postgres::Client;

use crate::error::{AppError, AppResult};

const USER_SCHEMAS: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%'
    AND n.nspname NOT LIKE 'pg\\_temp\\_%'";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationKind {
    Table,
    PartitionedTable,
    ForeignTable,
    View,
    MaterializedView,
}

impl RelationKind {
    fn from_relkind(relkind: &str) -> Self {
        match relkind {
            "p" => RelationKind::PartitionedTable,
            "f" => RelationKind::ForeignTable,
            "v" => RelationKind::View,
            "m" => RelationKind::MaterializedView,
            _ => RelationKind::Table,
        }
    }

    fn is_view(self) -> bool {
        matches!(self, RelationKind::View | RelationKind::MaterializedView)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInfo {
    pub name: String,
    pub kind: RelationKind,
    /// pg_class.reltuples; None when the table has never been analysed.
    pub row_estimate: Option<i64>,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub oid: u32,
    pub name: String,
    pub arguments: String,
    pub result: Option<String>,
    pub is_procedure: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjects {
    pub tables: Vec<RelationInfo>,
    pub views: Vec<RelationInfo>,
    pub functions: Vec<FunctionInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// Short type name with modifiers, e.g. "int8", "numeric(10,2)", "varchar(40)".
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    /// "always" or "by default" for identity columns.
    pub identity: Option<String>,
    /// Expression of a stored generated column.
    pub generated: Option<String>,
    pub is_primary_key: bool,
    pub is_foreign_key: bool,
    /// Single-column UNIQUE constraint.
    pub is_unique: bool,
    /// "schema.table(column)" the foreign key points at.
    pub references: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
    pub row_estimate: Option<i64>,
    pub size_bytes: Option<i64>,
    pub index_count: i64,
    pub comment: Option<String>,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationRef {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// Tables and views in the schema; lets the UI pick which one to open first.
    pub relation_count: i64,
}

pub async fn list_schemas(client: &Client) -> AppResult<Vec<SchemaInfo>> {
    let sql = format!(
        "SELECT n.nspname::text,
                (SELECT count(*) FROM pg_catalog.pg_class c
                 WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'f', 'v', 'm'))
         FROM pg_catalog.pg_namespace n
         WHERE {USER_SCHEMAS}
         ORDER BY n.nspname <> 'public', n.nspname"
    );
    Ok(client
        .query(&sql, &[])
        .await?
        .iter()
        .map(|r| SchemaInfo { name: r.get(0), relation_count: r.get(1) })
        .collect())
}

pub async fn list_schema_objects(client: &Client, schema: &str) -> AppResult<SchemaObjects> {
    let params: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[&schema];
    let relations = client.query(
        "SELECT c.relname::text,
                c.relkind::text,
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END,
                CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_total_relation_size(c.oid) END
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
         ORDER BY c.relname",
        params,
    );
    let functions = client.query(
        "SELECT p.oid, p.proname::text,
                pg_get_function_identity_arguments(p.oid),
                pg_get_function_result(p.oid),
                p.prokind = 'p'
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1
           AND p.prokind IN ('f', 'p')
           -- hide functions that belong to extensions (pgcrypto, postgis, …)
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                           WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                             AND d.objid = p.oid AND d.deptype = 'e')
         ORDER BY p.proname, 3",
        params,
    );
    let (relations, functions) = tokio::try_join!(relations, functions)?;

    let mut tables = Vec::new();
    let mut views = Vec::new();
    for row in relations {
        let info = RelationInfo {
            name: row.get(0),
            kind: RelationKind::from_relkind(row.get(1)),
            row_estimate: row.get(2),
            size_bytes: row.get(3),
        };
        if info.kind.is_view() {
            views.push(info);
        } else {
            tables.push(info);
        }
    }
    let functions = functions
        .iter()
        .map(|row| FunctionInfo {
            oid: row.get(0),
            name: row.get(1),
            arguments: row.get(2),
            result: row.get(3),
            is_procedure: row.get(4),
        })
        .collect();
    Ok(SchemaObjects { tables, views, functions })
}

pub async fn describe_table(client: &Client, schema: &str, name: &str) -> AppResult<TableDetails> {
    let row = client
        .query_opt(
            "SELECT c.oid, c.relkind::text,
                    CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::int8 END,
                    CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_total_relation_size(c.oid) END,
                    (SELECT count(*) FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid),
                    obj_description(c.oid, 'pg_class')
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &name],
        )
        .await?
        .ok_or_else(|| AppError::invalid(format!("{schema}.{name} no longer exists. Refresh the explorer.")))?;
    let oid: u32 = row.get(0);

    let columns = client
        .query(
            "SELECT a.attname::text,
                    format_type(a.atttypid, a.atttypmod),
                    NOT a.attnotnull,
                    CASE WHEN a.attgenerated = '' THEN pg_get_expr(ad.adbin, ad.adrelid) END,
                    CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by default' END,
                    CASE WHEN a.attgenerated <> '' THEN pg_get_expr(ad.adbin, ad.adrelid) END,
                    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                            WHERE k.conrelid = a.attrelid AND k.contype = 'p' AND a.attnum = ANY (k.conkey)),
                    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                            WHERE k.conrelid = a.attrelid AND k.contype = 'u' AND k.conkey = ARRAY[a.attnum]),
                    (SELECT quote_ident(fn.nspname) || '.' || quote_ident(fc.relname) || '(' || quote_ident(fa.attname) || ')'
                       FROM pg_catalog.pg_constraint k
                       JOIN pg_catalog.pg_class fc ON fc.oid = k.confrelid
                       JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
                       JOIN pg_catalog.pg_attribute fa
                         ON fa.attrelid = k.confrelid
                        AND fa.attnum = k.confkey[array_position(k.conkey, a.attnum)]
                      WHERE k.conrelid = a.attrelid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)
                      ORDER BY k.conname
                      LIMIT 1),
                    col_description(a.attrelid, a.attnum)
             FROM pg_catalog.pg_attribute a
             LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&oid],
        )
        .await?
        .iter()
        .map(|r| {
            let references: Option<String> = r.get(8);
            ColumnInfo {
                name: r.get(0),
                data_type: short_type(r.get(1)),
                nullable: r.get(2),
                default_value: r.get(3),
                identity: r.get(4),
                generated: r.get(5),
                is_primary_key: r.get(6),
                is_unique: r.get(7),
                is_foreign_key: references.is_some(),
                references,
                comment: r.get(9),
            }
        })
        .collect();

    Ok(TableDetails {
        schema: schema.to_owned(),
        name: name.to_owned(),
        kind: RelationKind::from_relkind(row.get(1)),
        row_estimate: row.get(2),
        size_bytes: row.get(3),
        index_count: row.get(4),
        comment: row.get(5),
        columns,
    })
}

/// Every table and view in user schemas, for the ⌘K jump box.
pub async fn list_relations(client: &Client) -> AppResult<Vec<RelationRef>> {
    let sql = format!(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND {USER_SCHEMAS}
         ORDER BY n.nspname <> 'public', n.nspname, c.relname
         LIMIT 5000"
    );
    Ok(client
        .query(&sql, &[])
        .await?
        .iter()
        .map(|r| RelationRef { schema: r.get(0), name: r.get(1), kind: RelationKind::from_relkind(r.get(2)) })
        .collect())
}

pub async fn function_definition(client: &Client, oid: u32) -> AppResult<String> {
    let row = client.query_one("SELECT pg_get_functiondef($1)", &[&oid]).await?;
    Ok(row.get(0))
}

/// Turns format_type() output into the short names Postgres people type:
/// "bigint" → "int8", "character varying(40)" → "varchar(40)",
/// "timestamp(3) with time zone" → "timestamptz(3)", "integer[]" → "int4[]".
pub fn short_type(full: &str) -> String {
    let (base, arrays) = match full.find("[]") {
        Some(i) => (&full[..i], &full[i..]),
        None => (full, ""),
    };
    // Split off a "(…)" modifier that may sit in the middle ("timestamp(3) with time zone").
    let (name, modifier) = match (base.find('('), base.find(')')) {
        (Some(open), Some(close)) if close > open => {
            let name = format!("{}{}", &base[..open], &base[close + 1..]);
            (name, &base[open..=close])
        }
        _ => (base.to_owned(), ""),
    };
    let short = match name.trim() {
        "bigint" => "int8",
        "integer" => "int4",
        "smallint" => "int2",
        "boolean" => "bool",
        "double precision" => "float8",
        "real" => "float4",
        "character varying" => "varchar",
        "character" => "char",
        "bit varying" => "varbit",
        "timestamp with time zone" => "timestamptz",
        "timestamp without time zone" => "timestamp",
        "time with time zone" => "timetz",
        "time without time zone" => "time",
        other => other,
    };
    format!("{short}{modifier}{arrays}")
}

#[cfg(test)]
mod tests {
    use super::short_type;

    #[test]
    fn shortens_type_names() {
        assert_eq!(short_type("bigint"), "int8");
        assert_eq!(short_type("character varying(40)"), "varchar(40)");
        assert_eq!(short_type("character(2)"), "char(2)");
        assert_eq!(short_type("numeric(10,2)"), "numeric(10,2)");
        assert_eq!(short_type("timestamp with time zone"), "timestamptz");
        assert_eq!(short_type("timestamp(3) with time zone"), "timestamptz(3)");
        assert_eq!(short_type("integer[]"), "int4[]");
        assert_eq!(short_type("text[]"), "text[]");
        assert_eq!(short_type("playground.email_address"), "playground.email_address");
        assert_eq!(short_type("order_status"), "order_status");
    }
}
