/**
 * TemplateVar
 * Reads server-injected template variables from the DOM.
 */
export class TemplateVar {
    static vars = {};
    static isBuilt = false;

    /**
     * Parses template variables from the embedded JSON script tag.
     */
    static build() {
        const script = document.querySelector("#template-vars");
        if (!script) {
            return;
        }

        try {
            const vars = JSON.parse(script.textContent || "{}");
            Object.entries(vars).forEach(function(entry) {
                const key = entry[0];
                const value = entry[1];
                TemplateVar.vars[key] = value;
            });
        } catch (error) {
            console.error("Error parsing template variables:", error);
        }

        script.remove();
        TemplateVar.isBuilt = true;
    }

    /**
     * Returns one template variable or the full variable map.
     */
    static get(key) {
        if (!TemplateVar.isBuilt) {
            TemplateVar.build();
        }

        if (!key) {
            return TemplateVar.vars;
        }

        return TemplateVar.vars[key];
    }

    /**
     * Stores one template variable in memory.
     */
    static set(key, value) {
        TemplateVar.vars[key] = value;
    }
}
