import {json} from "micro";
import {Readable, Transform} from "node:stream";
import JSONStream from "JSONStream";

import {
  validateDescribeColumnsPayload,
  validateQueryPayload,
} from "./validate.js";
import {badRequest} from "./errors.js";

export class DatabricksSingleton {
  static instance = null;
  static types = new Map();
  constructor() {
    throw new Error(
      "Do not use new DatabricksSingleton(). Call DatabricksSingleton.initialize() instead."
    );
  }
  static initialize() {
    if (!DatabricksSingleton.instance) {
      try {
        DatabricksSingleton.instance = import("@databricks/sql").then(
          (module) => {
            const databricks = module.default;
            const {TCLIService_types} = databricks.thrift;

            const boolean = ["null", "boolean"],
              integer = ["null", "integer"],
              number = ["null", "number"],
              object = ["null", "object"],
              string = ["null", "string"];

            DatabricksSingleton.types
              .set(TCLIService_types.TTypeId.BIGINT_TYPE, {
                type: integer,
              })
              .set(TCLIService_types.TTypeId.BINARY_TYPE, {
                type: object,
                buffer: true,
              })
              .set(TCLIService_types.TTypeId.BOOLEAN_TYPE, {
                type: boolean,
              })
              .set(TCLIService_types.TTypeId.TINYINT_TYPE, {
                type: integer,
              })
              .set(TCLIService_types.TTypeId.SMALLINT_TYPE, {
                type: integer,
              })
              .set(TCLIService_types.TTypeId.INT_TYPE, {
                type: integer,
              })
              .set(TCLIService_types.TTypeId.DECIMAL_TYPE, {
                type: number,
                decimal: true,
              })
              .set(TCLIService_types.TTypeId.DOUBLE_TYPE, {
                type: number,
              })
              .set(TCLIService_types.TTypeId.FLOAT_TYPE, {
                type: number,
              })
              .set(TCLIService_types.TTypeId.TIMESTAMP_TYPE, {
                type: string,
                date: true,
              })
              .set(TCLIService_types.TTypeId.DATE_TYPE, {
                type: string,
                date: true,
              })
              .set(TCLIService_types.TTypeId.INTERVAL_DAY_TIME_TYPE, {
                type: string,
                date: true,
              })
              .set(TCLIService_types.TTypeId.INTERVAL_YEAR_MONTH_TYPE, {
                type: string,
                date: true,
              });

            return databricks;
          }
        );
      } catch (err) {
        console.error(err);
      }
    }
  }
  static getInstance() {
    if (!DatabricksSingleton.instance)
      throw new Error(
        "DatabricksSingleton not initialized. Call DatabricksSingleton.initialize() first."
      );
    return DatabricksSingleton.instance;
  }

  get types() {
    if (DatabricksSingleton.types.size === 0)
      throw new Error(
        "DatabricksSingleton not initialized. Call DatabricksSingleton.initialize() first."
      );
    return DatabricksSingleton.types;
  }
}

export async function describeTables(req, res, connection) {
  const tablesData = {};
  const session = await new Promise((resolve, reject) => {
    connection.on("error", reject).openSession().then(resolve);
  });

  try {
    const catalogOperation = await session.getCatalogs({runAsync: true});
    const catalogs = await catalogOperation.fetchAll();

    for (const catalog of catalogs) {
      const tableOperation = await session.getTables({
        catalogName: catalog.TABLE_CAT,
        runAsync: true,
      });
      const tables = await tableOperation.fetchAll();
      tables.forEach(
        (table) =>
          (tablesData[
            `${table.TABLE_CAT}.${table.TABLE_SCHEM}.${table.TABLE_NAME}`
          ] = table)
      );
    }
  } catch (error) {
    if (!error.statusCode) error.statusCode = 400;
    throw error;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (err) {
        console.error(err);
      }
    }

    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error(err);
      }
    }
  }

  return tablesData;
}

export async function describeColumns(req, res, connection) {
  let columns = [];
  const session = await new Promise((resolve, reject) => {
    connection.on("error", reject).openSession().then(resolve);
  });

  const body = await json(req);

  if (!validateDescribeColumnsPayload(body)) throw badRequest();

  const {table, catalog, schema} = body;

  try {
    const columnsOperation = await session.getColumns({
      catalogName: catalog,
      schemaName: schema,
      tableName: table,
      runAsync: true,
    });
    columns = await columnsOperation.fetchAll();
  } catch (error) {
    if (!error.statusCode) error.statusCode = 400;
    throw error;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (err) {
        console.error(err);
      }
    }

    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error(err);
      }
    }
  }

  return columns;
}

/*
 * This function is running a given query and streams the results back to the client.
 * */
export async function queryStream(req, res, connection) {
  let query;
  const session = await new Promise((resolve, reject) => {
    connection.on("error", reject).openSession().then(resolve);
  });

  const body = await json(req);

  if (!validateQueryPayload(body)) throw badRequest();

  res.setHeader("Content-Type", "text/plain");
  const keepAlive = setInterval(() => res.write("\n"), 25e3);

  let {sql, params = []} = body;

  if (params.length) {
    sql = params.reduce((sql, p, idx) => {
      if (typeof p === "string") {
        // If the parameter is a string that includes the ' (exclusion character),
        // we need to add the r tag to treat it as raw-literal string.
        p = p.match(/'/g) ? `r'${p}'` : `'${p}'`;
      }

      return sql.replace(`:${idx + 1}`, p);
    }, sql);
  }

  try {
    query = await session.executeStatement(sql, {runAsync: true});
    const rows = await query.fetchAll();
    const timestampFieldMap = new Map();
    const schema = await query.getSchema();

    const responseSchema = {
      type: "array",
      items: {
        type: "object",
        properties: schema.columns.reduce((schema, col) => {
          // If the column is a timestamp, we need keep track of its key.
          // We will use this later to convert the timestamp to a UTC ISO-96801 format.
          if (col.typeDesc.types[0].primitiveEntry.type === 8) {
            timestampFieldMap.set(col.columnName, "TIMESTAMP");
          }
          return {
            ...schema,
            ...{
              [col.columnName]: dataTypeSchema(
                col.typeDesc.types[0].primitiveEntry.type
              ),
            },
          };
        }, {}),
      },
    };
    res.write(`${JSON.stringify(responseSchema)}`);
    res.write("\n");

    await new Promise(async (resolve, reject) => {
      const stream = new Readable.from(rows);

      stream.once("data", () => {
        clearInterval(keepAlive);
      });

      stream.on("close", (error) => {
        resolve();
        stream.destroy();
      });

      stream.on("error", reject);

      stream
        .pipe(
          new Transform({
            objectMode: true,
            transform(chunk, encoding, callback) {
              let row = null;
              try {
                row = Object.entries(chunk).reduce((row, [key, value]) => {
                  return {
                    ...row,
                    ...{
                      [key]: timestampFieldMap.has(key) ? `${value}Z` : value,
                    },
                  };
                }, {});
              } catch (e) {
                console.error("row has unexpected format");
                // TODO: Add error handling once server supports handling error for in flight streamed response
                // cb(new Error(e));
              }
              callback(null, row);
            },
          })
        )
        .pipe(JSONStream.stringify("", "\n", "\n"))
        .pipe(res);
    });
  } catch (error) {
    if (!error.statusCode) error.statusCode = 400;
    // The default error message is too generic.
    // We want to show a more explicit error message, such as "Table not found" ...etc.
    if (error?.response?.displayMessage)
      error.message = error.response.displayMessage;

    throw error;
  } finally {
    clearInterval(keepAlive);

    if (query) {
      try {
        await query.close();
      } catch (err) {
        console.error(err);
      }
    }

    if (session) {
      try {
        await session.close();
      } catch (err) {
        console.error(err);
      }
    }

    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error(err);
      }
    }
  }

  res.end();
}

/*
 * This function is checking for the validity of the credentials.
 * */
export async function check(req, res, connection) {
  try {
    // If a session fails to open, currently the error is not propagating correctly.
    // see: https://github.com/databricks/databricks-sql-nodejs/issues/77
    await new Promise((resolve, reject) => {
      connection.on("error", reject).openSession().then(resolve);
    });

    return {ok: true};
  } catch (e) {
    throw e;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error(err.message);
      }
    }
  }
}

export default ({token, host, path}) => {
  DatabricksSingleton.initialize();
  return async (req, res) => {
    const databricks = await DatabricksSingleton.getInstance();
    const client = new databricks.DBSQLClient();
    const connection = await client.connect({token, host, path});

    if (req.method === "POST") {
      if (req.url === "/describe-tables") {
        return describeTables(req, res, connection);
      }

      if (req.url === "/describe-columns") {
        return describeColumns(req, res, connection);
      }
    }

    return queryStream(req, res, connection);
  };
};

// See https://github.com/databricks/databricks-sql-nodejs/blob/main/tests/unit/result/JsonResult.test.js
function dataTypeSchema(type) {
  const types = DatabricksSingleton.types;
  if (types.has(type)) {
    return types.get(type);
  }

  return {type: ["null", "string"]};
}
