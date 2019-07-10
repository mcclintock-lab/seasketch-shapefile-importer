const shapefile = require("shapefile");
const ora = require("ora");
const fs = require("fs");
const srs = require("srs");
const inquirer = require("inquirer");
const Terraformer = require("terraformer");
Terraformer.ArcGIS = require("terraformer-arcgis-parser");
const { reproject } = require("reproject");
const mongoose = require("mongoose");
const SketchClass = mongoose.model("SketchClass", { name: String });
const FormAttribute = mongoose.model("FormAttribute", {
  sketchclassid: mongoose.Schema.ObjectId,
  exportid: String,
  choices: mongoose.Schema.Types.Mixed
});

const sketchSchema = new mongoose.Schema({ name: String }, {strict: false});
const Sketch = mongoose.model("Sketch", sketchSchema);
const lgSchema = new mongoose.Schema({ type: String, geometry: {} }, {strict: false});
const LargeGeometry = mongoose.model("LargeGeometry", sketchSchema);
const accepted = [];
const rejected = [];
const errors = [];

const checkProjection = path => {
  const prjPath = path.replace(".shp", ".prj");
  let projText;
  try {
    projText = fs.readFileSync(prjPath);
  } catch (e) {}
  if (!projText) {
    return false;
  } else {
    const { srid } = srs.parse(projText);
    return srid === 4326;
  }
};

const toEsriFeature = geojson => {
  const geometryType = `esriGeometry${geojson.geometry.type.replace('Multi', '')}`;
  // convert to epsg 3857
  const feature = reproject(geojson, "EPSG:4326", "EPSG:3857");
  // add OBJECTID field
  feature.properties.OBJECTID = 1;
  feature.properties.FID = 1;
  // convert to esriJson
  return {
    features: [Terraformer.ArcGIS.convert(feature, { sr: 3857 })],
    fields: [
      { "alias": "FID", "type": "esriFieldTypeOID", "name": "FID" }
    ],
    geometryType: geometryType,
    spatialReference: {latestWkid: 3857, wkid: 102100}
  }
};

const sketchClasses = {};
const getSketchClass = async id => {
  if (sketchClasses[id]) {
    return sketchClasses[id];
  } else {
    const sketchClass = await SketchClass.findById(id).exec();
    sketchClasses[id] = sketchClass;
    sketchClasses[id].attributes = {};
    const formAttributes = await FormAttribute.find({sketchclassid: sketchClass._id, deletedAt: new Date(0)}).exec();
    for (let attr of formAttributes) {
      sketchClasses[id].attributes[attr.exportid] = attr;
    }
    return sketchClass;
  }
};

const folders = {};
const getOrCreateFolder = async (name, sketchclassid, project, user) => {
  if (folders[name]) {
    return folders[name];
  } else {
    const sketchClass = await getSketchClass(sketchclassid);
    const sketch = new Sketch({
      name,
      sketchclass: sketchClass._id.toString(),
      project: project,
      user: user,
      inMessage: false,
      deletedAt: new Date(0),
      isCollection: true,
      attributes: {}
    });
    const folder = await sketch.save();
    folders[name] = folder;
    return folders[name];
  }
}

// TODO: verify geometry type matches sketchclass
const toSketch = async (geometry, properties, project, user, staticGeometry=true) => {
  const sketchClass = await getSketchClass(properties.SKETCH_CLASS_ID);
  let folder = null;
  if (properties.FOLDER) {
    folder = await getOrCreateFolder(properties.FOLDER.name, properties.FOLDER.type, project, user);
    delete properties.FOLDER;
  }
  const sketch = {
    name: properties['NAME'],
    sketchclass: sketchClass._id,
    project: project,
    user: user,
    inMessage: false,
    geometry,
    // otherwise Seasketch will think it's a collection
    preprocessedgeometryid: 1,
    deletedAt: new Date(0),
    geometryOriginal: {
      ...geometry.features[0].geometry
    },
    parentid: folder ? folder._id : null,
    staticGeometry,
    isCollection: false,
    attributes: Object.keys(properties).reduce((prev, current) => {
      const field = sketchClass.attributes[current];
      if (field) {
        prev[field._id.toString()] = properties[current];
      }
      return prev
    }, {})
  };
  return sketch;
};

const saveSketch = async (attrs) => {
  const geom = new LargeGeometry({type: 'preprocessed', geometry: attrs.geometry});
  await geom.save();
  const sketch = new Sketch({
    ...attrs,
    preprocessedgeometryid: geom._id
  });
  await sketch.save();
  return sketch;
}

const importSketches = async (
  path,
  connectionString,
  userId,
  projectId,
  mapFunction
) => {
  mongoose.connect(connectionString, { useNewUrlParser: true });
  const spinner = ora(`Opening ${path}`).start();
  const source = await shapefile.open(path);
  spinner.succeed(`Opened ${path}`);
  spinner.start(`Checking .prj file at ${path.replace(".shp", ".prj")}`);
  if (!checkProjection(path)) {
    // console.log('prompt');
    spinner.stop();
    const answers = await inquirer.prompt([
      {
        type: "confirm",
        name: "proj",
        message: "Projection cannot be confirmed to be 4326. Proceed anyways?"
      }
    ]);
    if (!answers.proj) {
      process.exit();
    }
  } else {
    spinner.succeed(`Verified projection is 4326`);
  }
  let i = 0;
  let result = await source.read();
  spinner.start(`Processing feature ${i++}`);
  while (!result.done) {
    result = await source.read();
    if (result.value) {
      try {
        const properties = await mapFunction(
          result.value.geometry,
          result.value.properties
        );
        if (properties) {
          const feature = toEsriFeature({
            ...result.value,
            properties
          });
          const sketch = await toSketch(feature, properties, projectId, userId);
          accepted.push(sketch);
        } else {
          rejected.push(result);
        }
      } catch (e) {
        errors.push(e);
      }
      spinner.text = `Processing feature ${i++}`;
    }
  }
  spinner.succeed(`Processed ${i} features`);
  if (errors.length) {
    console.log(`Encountered ${errors.length} errors`);
    for (let err of errors) {
      console.log("\n");
      console.error(err);
      console.log("\n");
    }
    console.log(`${errors.length} errors`);
    mongoose.disconnect();
    process.exit();
  } else {
    const answers = await inquirer.prompt([
      {
        type: "list",
        name: "importType",
        message: `How would you like to proceed?`,
        choices: [ "Cancel", "Import 1 sample sketch", `Import all ${accepted.length} sketches`]
      }
    ]);
    if (answers.importType === "Import 1 sample sketch") {
      spinner.start("Uploading single sketch");
      const sketch = await saveSketch(accepted[0]);
      spinner.succeed(`Uploaded single sketch (${sketch._id})`);
      mongoose.disconnect();      
      // process.exit();
    } else if (answers.importType === `Import all ${accepted.length} sketches`) {
      spinner.start("Uploading all sketches");
      for (var j = 0; j < accepted.length; j++) {
        spinner.text = `Uploading sketch ${j+1}/${accepted.length}`;
        await saveSketch(accepted[j]);
      }
      spinner.succeed("Uploaded all sketches");
      mongoose.disconnect();
      // process.exit();      
    } else {
      mongoose.disconnect();
      // process.exit();
    }
  }
};

module.exports = importSketches;
