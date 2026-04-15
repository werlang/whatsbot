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
                'template-vars': `<script id="template-vars" type="application/json">${JSON.stringify(mergedVars)}</script>`,
            });
        };

        next();
    };
}

export { renderMiddleware };
