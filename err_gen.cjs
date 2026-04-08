'use strict';

const fs = require('fs');
const crypto = require('crypto');

const calculateChecksum = (hexString) => {
  let checksum = 0;
  for (let i = 0; i < hexString.length; i++) {
    checksum += Number.parseInt(hexString[i], 16);
  }
  return (checksum % 16).toString(16).toUpperCase();
};

const stableHex = (input, length) => {
  return crypto.createHash('sha256').update(String(input)).digest('hex').toUpperCase().slice(0, length);
};

const randomHex = (length) => {
  const bytes = Math.ceil(length / 2);
  return crypto.randomBytes(bytes).toString('hex').toUpperCase().slice(0, length);
};

const normalizePrefix = (prefix) => {
  const v = (prefix || '').toUpperCase();
  if (v.length > 4) throw new Error('Prefix length must be 0-4 characters.');
  if (!/^[0-9A-F]*$/.test(v)) throw new Error('Prefix must only contain hex characters (0-9, A-F).');
  return v;
};

const validateErrorCode = (errorCode) => {
  if (!/^[0-9A-F]{16}$/.test(errorCode)) return false;
  const payload = errorCode.slice(0, 15);
  const checksum = errorCode.slice(15);
  return calculateChecksum(payload) === checksum;
};

const generateHexCode = ({ prefix = '', errorKey, errorCodeMap, deterministicOnly = false }) => {
  const cleanPrefix = normalizePrefix(prefix);
  const baseLen = 14 - cleanPrefix.length;
  const stableLen = Math.max(4, baseLen - 4);
  const randomLen = baseLen - stableLen;

  const stablePart = stableHex(errorKey, stableLen);
  const entropyPart = deterministicOnly ? stableHex(`${errorKey}:entropy`, randomLen) : randomHex(randomLen);

  let code = `${cleanPrefix}${stablePart}${entropyPart}`;

  const countNibble = (Object.keys(errorCodeMap).length % 16).toString(16).toUpperCase();
  code += countNibble;

  const checksum = calculateChecksum(code);
  code += checksum;

  return code;
};

const addErrorCode = (errorKey, prefix = '', errorCodeMap, deterministicOnly = false) => {
  if (errorCodeMap[errorKey]) {
    throw new Error(`Error key '${errorKey}' already exists.`);
  }

  const existingCodes = new Set(Object.values(errorCodeMap));
  for (let i = 0; i < 32; i++) {
    const candidate = generateHexCode({ prefix, errorKey: `${errorKey}:${i}`, errorCodeMap, deterministicOnly });
    if (!existingCodes.has(candidate)) {
      errorCodeMap[errorKey] = candidate;
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique error code after 32 attempts.');
};

const getErrorCodeByKey = (errorKey, errorCodeMap) => {
  return errorCodeMap[errorKey] || null;
};

const searchErrorCodesByPrefix = (prefix, errorCodeMap) => {
  const p = String(prefix || '').toUpperCase();
  return Object.keys(errorCodeMap)
    .filter((key) => errorCodeMap[key].startsWith(p))
    .map((key) => ({ errorKey: key, errorCode: errorCodeMap[key] }));
};

const listAllErrorCodes = (errorCodeMap) => {
  return Object.keys(errorCodeMap)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      errorKey: key,
      errorCode: errorCodeMap[key]
    }));
};

const deleteErrorCode = (errorKey, errorCodeMap) => {
  if (!errorCodeMap[errorKey]) {
    throw new Error(`Error key '${errorKey}' does not exist.`);
  }
  const deleted = errorCodeMap[errorKey];
  delete errorCodeMap[errorKey];
  return deleted;
};

const duplicateCodes = (errorCodeMap) => {
  const seen = new Map();
  const dups = [];
  for (const [key, code] of Object.entries(errorCodeMap)) {
    if (seen.has(code)) {
      dups.push({ errorCode: code, keys: [seen.get(code), key] });
    } else {
      seen.set(code, key);
    }
  }
  return dups;
};

const loadErrorCodeMap = (filePath) => {
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  }
  return {};
};

const saveErrorCodeMap = (filePath, errorCodeMap) => {
  const sorted = Object.keys(errorCodeMap)
    .sort((a, b) => a.localeCompare(b))
    .reduce((acc, key) => {
      acc[key] = errorCodeMap[key];
      return acc;
    }, {});
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + '\n');
};

const processCliArgs = (args) => {
  const cliOptions = {
    errorFile: null,
    action: null,
    errorInputFile: null,
    errorOutputFile: null,
    errorKey: null,
    errorCode: null,
    prefix: '',
    deterministic: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-ef':
      case '--error-file':
        cliOptions.errorFile = args[i + 1];
        i++;
        break;
      case '-m':
      case '--action':
        cliOptions.action = args[i + 1];
        i++;
        break;
      case '-if':
      case '--error-input-file':
        cliOptions.errorInputFile = args[i + 1];
        i++;
        break;
      case '-of':
      case '--error-output-file':
        cliOptions.errorOutputFile = args[i + 1];
        i++;
        break;
      case '-ek':
      case '--error-key':
        cliOptions.errorKey = args[i + 1];
        i++;
        break;
      case '-ec':
      case '--error-code':
        cliOptions.errorCode = args[i + 1];
        i++;
        break;
      case '-p':
      case '--prefix':
        cliOptions.prefix = args[i + 1];
        i++;
        break;
      case '--deterministic':
        cliOptions.deterministic = true;
        break;
      default:
        throw new Error(`Unknown option: ${args[i]}`);
    }
  }

  return cliOptions;
};

const main = () => {
  try {
    const args = processCliArgs(process.argv.slice(2));

    let errorCodeMap = {};
    if (args.errorFile) {
      errorCodeMap = loadErrorCodeMap(args.errorFile);
    } else if (args.errorInputFile) {
      errorCodeMap = loadErrorCodeMap(args.errorInputFile);
    }

    const dups = duplicateCodes(errorCodeMap);
    if (dups.length > 0) {
      console.error('Duplicate error codes detected:', JSON.stringify(dups));
      process.exit(1);
    }

    switch (args.action) {
      case 'add': {
        if (!args.errorKey) throw new Error('Error key is required for adding a new error code.');
        const newErrorCode = addErrorCode(args.errorKey, args.prefix, errorCodeMap, args.deterministic);
        console.log(`Added error key: ${args.errorKey} - ${newErrorCode}`);
        break;
      }

      case 'get': {
        if (!args.errorKey) throw new Error('Error key is required for retrieving an error code.');
        const errorCode = getErrorCodeByKey(args.errorKey, errorCodeMap);
        console.log(errorCode ? `Error code: ${errorCode}` : 'Error key not found.');
        break;
      }

      case 'search': {
        if (!args.prefix) throw new Error('Prefix is required for searching error codes.');
        const searchResults = searchErrorCodesByPrefix(args.prefix, errorCodeMap);
        console.log('Search results:', JSON.stringify(searchResults, null, 2));
        break;
      }

      case 'all': {
        const allErrorCodes = listAllErrorCodes(errorCodeMap);
        console.log('All error codes:', JSON.stringify(allErrorCodes, null, 2));
        break;
      }

      case 'delete': {
        if (!args.errorKey) throw new Error('Error key is required for deleting an error code.');
        const deleted = deleteErrorCode(args.errorKey, errorCodeMap);
        console.log(`Deleted error key: ${args.errorKey} - ${deleted}`);
        break;
      }

      case 'validate': {
        if (args.errorCode) {
          const ok = validateErrorCode(args.errorCode.toUpperCase());
          console.log(ok ? 'Valid error code.' : 'Invalid error code.');
          if (!ok) process.exit(1);
          break;
        }

        const failures = Object.entries(errorCodeMap)
          .filter(([, code]) => !validateErrorCode(String(code).toUpperCase()))
          .map(([key, code]) => ({ errorKey: key, errorCode: code }));

        if (failures.length > 0) {
          console.error('Invalid error codes:', JSON.stringify(failures, null, 2));
          process.exit(1);
        }

        console.log('All error codes are valid.');
        break;
      }

      default:
        throw new Error('Invalid action. Use add, get, search, all, delete, or validate.');
    }

    if (args.errorFile) {
      saveErrorCodeMap(args.errorFile, errorCodeMap);
    } else if (args.errorOutputFile) {
      saveErrorCodeMap(args.errorOutputFile, errorCodeMap);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
};

main();

