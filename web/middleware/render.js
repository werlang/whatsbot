/**
 * Escapes JSON content so it stays safe inside one inline script tag.
 */
function serializeTemplateVars(templateVars) {
    return JSON.stringify(templateVars).replace(/[<>&\u2028\u2029]/g, function(character) {
        return {
            '<': '\\u003c',
            '>': '\\u003e',
            '&': '\\u0026',
            '\u2028': '\\u2028',
            '\u2029': '\\u2029',
        }[character];
    });
}

/**
 * Creates middleware that injects shared template variables and a render helper.
 */
function renderMiddleware(fixedVars) {
    return (req, res, next) => {
        /**
         * Renders a view with merged fixed and request-scoped template variables.
         */
        res.templateRender = (view, templateVars = {}) => {
            const mergedVars = {
                ...fixedVars,
                ...templateVars,
            };

            for (const key of Object.keys(mergedVars)) {
                if (!mergedVars[key]) {
                    delete mergedVars[key];
                }
            }

            res.render(view, {
                ...mergedVars,
                'template-vars': `<script id="template-vars" type="application/json">${serializeTemplateVars(mergedVars)}</script>`,
            });
        };

        next();
    };
}

export { renderMiddleware, serializeTemplateVars };
