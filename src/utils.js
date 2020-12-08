function error(statusCode, message, err) {
  console.error(message, err); // eslint-disable-line

  return {
    statusCode: statusCode || 500,
    body      : message || 'Error rendering widget',
  };
}

function HttpError(statusCode, message) {
  this.message    = message;
  this.statusCode = statusCode;
}

const stringToRegex = (val) => {
  const regParts = val.match(/^\/(.*?)\/([gim]*)$/);
  if (regParts) {
    return new RegExp(regParts[1], regParts[2]);
  }
  return new RegExp(val);
};

module.exports = {
  error,
  HttpError,
  stringToRegex,
};
