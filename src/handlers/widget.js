const sanitizeHtml  = require('sanitize-html');
const request       = require('superagent');
const {
  keys, cloneDeep, filter, each, isString, isObject,
} = require('lodash');
const { Validator } = require('jsonschema');

const Handlebars                          = require('../handlebars').default;
const { error, stringToRegex, HttpError } = require('../utils');

let startTime;
let lastCall;

const debug = (message) => {

    if(process.env.debug){
        console.debug(new Date(), message, `${(((+new Date())-lastCall)/1000).toFixed(5)} secs`);
        lastCall = +new Date()
    }

}

const handleRequestError = (e)=>{
  console.error(`datasource load error, ignore and continue`, e);
  return {};
}

const validateJsonSchema = (schema, data) => {
  const jsonValidator = new Validator();

  const result = jsonValidator.validate(data, schema);

  return result;
};

const encodeParamValues = ($qs) => {
  each($qs,   (val, key) => {
    if (isString(val)) $qs[key] = encodeURIComponent(val); // eslint-disable-line
    else if (isObject(val)) $qs[key] = encodeParamValues(val); // eslint-disable-line
  });

  return $qs;
};

const renderTemplate = (rawTemplate, data, options) => {
  options                 = options || {}; // eslint-disable-line
  const handlebarTemplate = Handlebars.compile(rawTemplate, options);
  const result            = handlebarTemplate(data);

  return result;
};

function sanitizeWidget(widgetData) {
  const widget = {};

  const sanitizeOptions = {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([ 'img' ]),
  };

  widget.name        = widgetData.name;
  widget.template    = sanitizeHtml(widgetData.template, sanitizeOptions);
  widget.contentType = widgetData.contentType;
  widget.method      = widgetData.method;
  widget.queryString = widgetData.queryString;
  widget.formData    = widgetData.formData;
  widget.dataSource  = widgetData.dataSource;

  return JSON.parse(JSON.stringify(widget));
}

const validateWidget = (widget) => {
  if ((widget.template || '').trim() === '') throw new HttpError(403, 'Please provide widget template');

  if ((widget.contentType || '').trim() === '') throw new HttpError(403, 'Please provide widget contentType');

  if (widget.dataSource) {
    for (let i = 0; i < widget.dataSource.length; i++) {
      const dataSource = widget.dataSource[i];
      if ((dataSource.name || '').trim() === '') throw new HttpError(403, 'Please provide widget data source name');

      if ((dataSource.url || '').trim() === '') throw new HttpError(403, 'Please provide widget data source url');

      if ((dataSource.method || '').trim() === '') throw new HttpError(403, 'Please provide widget data source HTTP method');

      if (dataSource.queryString) {
        Object.keys(dataSource.queryString).forEach((key) => {
          const qs = dataSource.queryString[key];
          if (qs.type === 'regex') {
            try {
              stringToRegex(qs.validationRegex);
            } catch (E) {
              throw new HttpError(403, `Invalid queryString regex, ${qs} `);
            }
          } else if (qs.type === 'jsonSchema') {
            // TODO: json schema validation
            const schemaValidation = validateJsonSchema(qs.validationJsonSchema);
            if (schemaValidation.errors.length) {
              const errors = schemaValidation.errors.map(({ message, name }) => ({
                message: message.replace(/['"]/g, ''),
                name,
              }));
              throw new HttpError(403, errors);
            }
          } else {
            throw new HttpError(403, `Invalid data source queryString param type, ${qs} `);
          }
        });
      }
      if (dataSource.formData) {
        Object.keys(dataSource.formData).forEach((key) => {
          const qs = dataSource.formData[key];
          if (qs.type === 'regex') {
            try {
              stringToRegex(qs.validationRegex);
            } catch (E) {
              throw new HttpError(403, `Invalid formData field regex, ${qs} `);
            }
          } else if (qs.type === 'jsonSchema') {
            // TODO: json schema validation
            const schemaValidation = validateJsonSchema(qs.validationJsonSchema);
            if (schemaValidation.errors.length) {
              const errors = schemaValidation.errors.map(({ message, type }) => ({
                message: message.replace(/['"]/g, ''),
                type,
              }));
              throw new HttpError(403, errors);
            }
          } else {
            throw new HttpError(403, `Invalid data source formData param type, ${qs} `);
          }
        });
      }
    }
  }

  return true;
};

const validateParams = (params, validators, type) => {
  if(!validators || !params)
    return;
  const queryStringKeys = keys(params);
  const validatorKeys   = keys(validators);
  const missingParams   = filter(validatorKeys, (key) => !queryStringKeys.includes(key));
  const invalidParams   = [];

  if (missingParams.length) throw new HttpError(403, `The widget requires these params to proceed, "${missingParams.join('", "')}"`);

  // if(validatorKeys.length && !queryStringKeys.length)
  //     throw new HttpError(403, `The widget requires params to be passed in ${type}`);
  // // TODO: not sure if its good idea, maybe people want to pass cache buster
  //     if(!validatorKeys.length && queryStringKeys.length)
  //         throw new HttpError(403, `The widget is not configured tor receive params in ${type}`);

  /// //////

  if(validators){
    Object.keys(validators).forEach((key) => {
      const param = validators[key];

      if (param.type === 'regex') {
        const paramRegex = stringToRegex(param.validationRegex);
        if (!paramRegex.test(params[key])) {
          invalidParams.push(`Invalid value passed to ${type} param ${key}:${params[key]}`);
        }
      } else if (param.type === 'jsonSchema') {
        const schemaValidation = validateJsonSchema(param.validationJsonSchema, params[key]);
        if (schemaValidation.errors.length) {
          const errors = schemaValidation.errors.map(({ message, name }) => ({
            message: message.replace(/['"]/g, ''),
            name,
          }));
          throw new HttpError(403, errors);
        }
      }
    });
  }

  if (invalidParams.length) {
    throw new HttpError(403, invalidParams);
  }
};

const fetchDataSource = async ($qsSource, $formSource, dataSource) => {
  const $qs                = cloneDeep($qsSource);
  const $form              = cloneDeep($formSource);
  const dataSourceResult   = {};
  const dataSourcePromises = [];

  encodeParamValues($qs);
  encodeParamValues($form);
  
  if(dataSource){
    Object.keys(dataSource).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(dataSource, key)) {
        const source = cloneDeep(dataSource[key]);
        const query  = {
          url     : source.url,
          params  : {},
          formData: {},
        };
        // http://api.cbd.int/api/v2013/countries/{{$qs.param1}}-{{$form.param2}}
        query.url = renderTemplate(query.url, { $qs, $form }, { noEscape: true });

        // Add to data source querystring if configured
        if(source.queryString){
          Object.keys(source.queryString).forEach((param) => {
            if (Object.prototype.hasOwnProperty.call($qs, param)) {
              query.params[param] = $qs[param];
            }
          });
        }

        // TODO: not sure how form data will work yet.
        if(source.formData){
          Object.keys(source.formData).forEach((param) => {
            if (Object.prototype.hasOwnProperty.call($form, param)) {
              query.formData[param] = $form[param];
            }
          });
        }

        const normalizeResult = (result) => {
          let newResult;
          if (result && result.status === 200) {
            newResult = { name: source.name, source: result.body };
          }
          return newResult;
        };
        let queryPromise;
        if (source.method === 'GET') {
          queryPromise = request.get(query.url).query(query.params).then(normalizeResult).catch(handleRequestError);
        } else {
          queryPromise = request.post(query.url).query(query.params).send(query.formData).then(normalizeResult).catch(handleRequestError);
        }

        dataSourcePromises.push(queryPromise);
      }
    });
  }

  const promiseResult = await Promise.all(dataSourcePromises);
  promiseResult.forEach((result) => {
    if (result) dataSourceResult[result.name] = result.source;
  });
  //

  return dataSourceResult;
};

exports.renderHandler = async (event) => {

  startTime = +new Date();
  lastCall = +new Date();

  if (event.httpMethod !== 'POST') {
    throw new Error(`postMethod only accepts POST method, you tried: ${event.httpMethod} method.`);
  }

  // Get id and name from the body of the request
  const body = JSON.parse(event.body);
  
  debug(body)
  try {
    const widget = sanitizeWidget(body.widget);
    debug('sanitized');

    const templateData = {
      $qs  : body.$qs||{},
      $form: body.$form||{},
    };

    let queryStringValidators = widget.queryString || {};

    if ((widget.dataSource || []).length) {
      widget.dataSource.forEach((source) => {
        if (source.queryString) queryStringValidators = { ...queryStringValidators, ...source.queryString };
      });
    }

    debug('starting validation');

    debug('widget validation');
    validateWidget(widget);

    debug('$qs validation');
    validateParams(templateData.$qs,    queryStringValidators, 'queryString');

    debug('$form validation');
    validateParams(templateData.$form,  widget.formData, 'formData');
    
    debug('Finished validation');

    debug('starting fetch data source');
    templateData.$ds = await fetchDataSource(templateData.$qs,    templateData.$form, widget.dataSource);
    debug('finish data source fetch');

    const renderedTemplate = renderTemplate(widget.template, templateData);

    return {
      statusCode: 200,
      body      : renderedTemplate,
    };
  } catch (err) {
    if (err instanceof HttpError) {
      return error(err.statusCode, err.message, err);
    }
    return error(500, 'Error rendering widget', err);
  }
};
