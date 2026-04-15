import mysql from 'mysql2/promise';
import { CustomError } from './error.js';

/**
 * Shared MySQL helper used by the API models.
 */
class Mysql {
    static connected = false;
    static connection = null;

    /**
     * Opens the shared MySQL connection pool when needed.
     */
    static async connect(config = {}) {
        if (Mysql.connected && Mysql.connection) {
            return this;
        }

        Mysql.connection = mysql.createPool({
            host: 'mysql',
            port: 3306,
            user: 'root',
            password: process.env.MYSQL_ROOT_PASSWORD || '',
            database: process.env.MYSQL_DATABASE || 'whatsbot',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            timezone: 'Z',
            ...config,
        });
        Mysql.connected = true;
        return this;
    }

    /**
     * Retries the database connection until the configured MySQL service is reachable.
     */
    static async waitForReady({ attempts = 20, delayMs = 3000 } = {}) {
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await Mysql.connect();
                await Mysql.#query('SELECT 1');
                return this;
            } catch (error) {
                lastError = error;
                await Mysql.close();

                if (attempt < attempts) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        throw lastError;
    }

    /**
     * Closes the shared MySQL connection pool.
     */
    static async close() {
        if (!Mysql.connected || !Mysql.connection) {
            return this;
        }

        await Mysql.connection.end();
        Mysql.connection = null;
        Mysql.connected = false;
        return this;
    }

    /**
     * Quotes one SQL identifier, including dotted paths.
     */
    static #quoteIdentifier(identifier) {
        return String(identifier)
            .split('.')
            .map(part => part === '*' ? '*' : `\`${part}\``)
            .join('.');
    }

    /**
     * Executes one SQL statement through either the shared pool or one transaction connection.
     */
    static async #query(sql, data = [], { connection = null } = {}) {
        await Mysql.connect();
        const executor = connection || Mysql.connection;

        try {
            const [result] = await executor.execute(String(sql).trim(), data);
            return result;
        } catch (error) {
            throw new CustomError(error.message, {
                sql,
                data,
                error,
            });
        }
    }

    /**
     * Runs one callback inside a database transaction.
     */
    static async transaction(callback) {
        await Mysql.connect();
        const connection = await Mysql.connection.getConnection();

        try {
            await connection.beginTransaction();
            const result = await callback(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    /**
     * Inserts one or many rows into the provided table.
     */
    static async insert(table, data, { connection = null } = {}) {
        if (!data) {
            throw new CustomError('Invalid data for insert operation.');
        }

        const rows = Array.isArray(data) ? data : [data];
        const inserted = [];

        for (const row of rows) {
            const fields = Object.keys(row).map(key => `\`${key}\``);
            const values = Object.values(row);
            const sql = `INSERT INTO \`${table}\` (${fields.join(', ')}) VALUES (${values.map(() => '?').join(', ')})`;
            inserted.push(await Mysql.#query(sql, values, { connection }));
        }

        return inserted;
    }

    /**
     * Updates rows in the provided table using an id or filter clause.
     */
    static async update(table, data, clause, { connection = null } = {}) {
        if (!clause) {
            throw new CustomError('No identifier provided for update.');
        }

        const sanitizedData = Object.fromEntries(
            Object.entries(data || {}).filter(([, value]) => value !== undefined),
        );

        if (Object.keys(sanitizedData).length === 0) {
            throw new CustomError('No data to update.');
        }

        const values = [];
        const fieldSql = Object.entries(sanitizedData).map(([key, value]) => {
            values.push(value);
            return `\`${key}\` = ?`;
        }).join(', ' );

        let whereSql = '\`id\` = ?';
        if (typeof clause === 'object') {
            const where = Mysql.getWhereStatements(clause);
            whereSql = where.statement;
            values.push(...where.values);
        } else {
            values.push(clause);
        }

        const sql = `UPDATE \`${table}\` SET ${fieldSql} WHERE ${whereSql}`;
    return Mysql.#query(sql, values, { connection });
    }

    /**
     * Deletes rows in the provided table using an id or filter clause.
     */
    static async delete(table, clause, { connection = null, limit = null } = {}) {
        if (!clause) {
            throw new CustomError('Invalid clause for delete operation.');
        }

        const values = [];
        let whereSql = '\`id\` = ?';
        if (typeof clause === 'object') {
            const where = Mysql.getWhereStatements(clause);
            whereSql = where.statement;
            values.push(...where.values);
        } else {
            values.push(clause);
        }

        const sql = `DELETE FROM \`${table}\` WHERE ${whereSql}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
    return Mysql.#query(sql, values, { connection });
    }

    /**
     * Builds a SQL WHERE clause and placeholder values from a filter object.
     */
    static getWhereStatements(filter = {}) {
        const values = [];
        const statement = Object.entries(filter).map(([key, value]) => {
            if (value === null) {
                return `${Mysql.#quoteIdentifier(key)} IS NULL`;
            }

            if (Array.isArray(value)) {
                if (value.length === 0) {
                    return '1 = 0';
                }

                values.push(...value);
                return `${Mysql.#quoteIdentifier(key)} IN (${value.map(() => '?').join(', ')})`;
            }

            if (value && typeof value === 'object') {
                if (Object.prototype.hasOwnProperty.call(value, 'in')) {
                    if (!Array.isArray(value.in) || value.in.length === 0) {
                        return '1 = 0';
                    }

                    values.push(...value.in);
                    return `${Mysql.#quoteIdentifier(key)} IN (${value.in.map(() => '?').join(', ')})`;
                }

                if (Object.prototype.hasOwnProperty.call(value, 'between')) {
                    values.push(value.between[0], value.between[1]);
                    return `${Mysql.#quoteIdentifier(key)} BETWEEN ? AND ?`;
                }

                if (Object.prototype.hasOwnProperty.call(value, 'not')) {
                    if (value.not === null) {
                        return `${Mysql.#quoteIdentifier(key)} IS NOT NULL`;
                    }

                    values.push(value.not);
                    return `${Mysql.#quoteIdentifier(key)} != ?`;
                }

                const operator = Object.keys(value)[0];
                values.push(Object.values(value)[0]);
                return `${Mysql.#quoteIdentifier(key)} ${operator} ?`;
            }

            values.push(value);
            return `${Mysql.#quoteIdentifier(key)} = ?`;
        }).join(' AND ' );

        return { statement, values };
    }

    /**
     * Finds rows using filter, projection, and paging options.
     */
    static async find(table, { filter = {}, view = [], opt = {}, connection = null } = {}) {
        const projection = Array.isArray(view) && view.length > 0
            ? view.map(item => Mysql.#quoteIdentifier(item)).join(', ' )
            : '*';
        const where = Object.keys(filter).length > 0
            ? Mysql.getWhereStatements(filter)
            : { statement: '', values: [] };
        const whereSql = where.statement ? `WHERE ${where.statement}` : '';
        const orderSql = opt.order
            ? `ORDER BY ${Mysql.#quoteIdentifier(Object.keys(opt.order)[0])} ${Object.values(opt.order)[0] === 1 ? 'ASC' : 'DESC'}`
            : '';
        const limitSql = opt.limit ? `LIMIT ${Number(opt.limit)}` : '';
        const offsetSql = opt.skip ? `OFFSET ${Number(opt.skip)}` : '';
        const sql = `SELECT ${projection} FROM \`${table}\` ${whereSql} ${orderSql} ${limitSql} ${offsetSql}`;
        return Mysql.#query(sql, where.values, { connection });
    }

    /**
     * Converts one timestamp-like value into the MySQL DATETIME format.
     */
    static toDateTime(timestamp) {
        return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ' );
    }

    /**
     * Builds a less-than-or-equal filter helper.
     */
    static lte(value) {
        return { '<=': value };
    }

    /**
     * Builds a greater-than-or-equal filter helper.
     */
    static gte(value) {
        return { '>=': value };
    }
}

export { Mysql };
