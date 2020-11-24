
const Handlebars     = require('handlebars');
const { capitalize } = require('lodash')

Handlebars.registerHelper('capitalize', (str) => {
    return capitalize(str);
});

exports.default = Handlebars;