import { Mysql } from "../helpers/mysql.js";

/**
 * Base model abstraction shared across the API persistence layer.
 */
class Model {
    static table = "";
    static driver = Mysql;
    static view = [];

    /**
     * Normalizes a raw database row into the model public shape.
     */
    static normalize(row) {
        return row;
    }

    /**
     * Serializes a model payload into database columns.
     */
    static serialize(payload) {
        return payload;
    }

    /**
     * Finds multiple records for the current model.
     */
    static async find({ filter = {}, view = this.view, opt = {} } = {}) {
        const rows = await this.driver.find(this.table, { filter, view, opt });
        return rows.map(row => this.normalize(row));
    }

    /**
     * Retrieves one record using an id or arbitrary filter clause.
     */
    static async get(clause, { view = this.view } = {}) {
        const filter = typeof clause === "object" ? clause : { id: clause };
        const rows = await this.driver.find(this.table, {
            filter,
            view,
            opt: { limit: 1 },
        });
        return this.normalize(rows[0]) || null;
    }

    /**
     * Inserts a new record for the current model.
     */
    static async insert(payload) {
        const serialized = this.serialize(payload);
        await this.driver.insert(this.table, serialized);
        return serialized;
    }

    /**
     * Updates records for the current model.
     */
    static async update(clause, payload) {
        const serialized = this.serialize(payload);
        await this.driver.update(this.table, serialized, clause);
    }

    /**
     * Deletes records for the current model.
     */
    static async delete(clause, opt = {}) {
        await this.driver.delete(this.table, clause, opt);
    }
}

export { Model };
