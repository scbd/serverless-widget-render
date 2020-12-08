const Handlebars     = require('handlebars');
const { capitalize } = require('lodash');

Handlebars.registerHelper('capitalize', (str) => capitalize(str));

exports.default = Handlebars;
