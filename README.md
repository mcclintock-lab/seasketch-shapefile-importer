# Installation

```
npm install @seasketch/shapefile-importer
```

# Usage

```javascript
const importSketches = require('@seasketch/shapefile-importer');
const path = require('path');

const DB = process.env.MONGO_DB_CONNECTION_STRING;
const USER_ID = process.env.USER_ID;
const PROJECT_ID = process.env.PROJECT_ID;
const shapefilePath = path.join(__dirname, 'data', 'shapes.shp');

importSketches(shapefilePath, DB, USER_ID, PROJECT_ID, async (geometry, attributes) => {
  return {
    NAME: attributes.UID,
    // split into sketch classes based on subregion
    SKETCH_CLASS_ID: attributes.SUBREGION === "CC" ? "123" : "abc",
    // You can specify a collection to create and place sketches within:
    FOLDER: {
      type: collectionIds[attributes.SUBREGION],
      name: `${attributes.SUBREGION} import`
    }
  }
});
```

Running this script will enable an interactive CLI that will report on how many sketches were 
generated, display any errors, and prompt whether to proceed with entry into the database. 