"use strict";

var base = require("xbase"),
	fs = require("fs"),
	path = require("path"),
	runUtil = require("xutil").run,
	fileUtil = require("xutil").file,
	moment = require("moment"),
	jsen = require("jsen"),
	jsonselect = require("JSONSelect"),
	diffUtil = require("xutil").diff,
	libxmljs = require("libxmljs"),
	C = require("C"),
	PEG = require("pegjs"),
	rimraf = require("rimraf"),
	tiptoe = require("tiptoe");

if(process.argv.length<3 || !fs.existsSync(process.argv[2]))
{
	base.error("Usage: node generate.js /path/to/hots");
	process.exit(1);
}

var HOTS_PATH = process.argv[2];
var HOTS_DATA_PATH = path.join(HOTS_PATH, "HeroesData");

if(!fs.existsSync(HOTS_DATA_PATH))
{
	base.error("HeroesData dir not found: %s", HOTS_DATA_PATH);
	process.exit(1);
}

var CASCEXTRATOR_PATH = path.join(__dirname, "CASCExtractor", "build", "bin", "CASCExtractor");

var OUT_PATH = path.join(__dirname, "out");
var OUT_MODS_PATH = path.join(OUT_PATH, "mods");

var HEROES_OUT_PATH = path.join(OUT_PATH, "heroes.json");

var EXTRA_HEROES = ["anubarak", "chen", "crusader", "jaina", "kaelthas", "lostvikings", "murky", "sonyarework", "sylvanas", "thrall"];
var NODE_MAPS = {};
var NODE_MAP_TYPES = ["Hero", "Talent", "Behavior", "Effect", "Abil", "Unit", "Validator", "Weapon" ];

var HERO_LEVEL_SCALING_MODS = {};

var NEEDED_SUBFIXES = [ "enus.stormdata\\LocalizedData\\GameStrings.txt" ];
NODE_MAP_TYPES.forEach(function(NODE_MAP_TYPE)
{
	NODE_MAPS[NODE_MAP_TYPE] = {};
	NEEDED_SUBFIXES.push("base.stormdata\\GameData\\" + NODE_MAP_TYPE.toProperCase() + "Data.xml");
});

var NEEDED_PREFIXES = ["heroesdata.stormmod"];
EXTRA_HEROES.forEach(function(EXTRA_HERO)
{
	NEEDED_PREFIXES.push("heromods\\" + EXTRA_HERO + ".stormmod");
});

var NEEDED_FILE_PATHS = [];

NEEDED_PREFIXES.forEach(function(NEEDED_PREFIX)
{
	NEEDED_SUBFIXES.forEach(function(NEEDED_SUBFIX)
	{
		NEEDED_FILE_PATHS.push("mods\\" + NEEDED_PREFIX + "\\" + NEEDED_SUBFIX);
	});
});

NEEDED_FILE_PATHS.push("mods\\heroesdata.stormmod\\base.stormdata\\GameData\\Heroes\\ZagaraData.xml");
NEEDED_FILE_PATHS.remove("mods\\heromods\\sonyarework.stormmod\\base.stormdata\\GameData\\UnitData.xml");
NEEDED_FILE_PATHS.remove("mods\\heromods\\sonyarework.stormmod\\base.stormdata\\GameData\\WeaponData.xml");

var FORMULA_PARSER = PEG.buildParser(fs.readFileSync(path.join(__dirname, "heroes.pegjs"), {encoding:"utf8"}));

var S = {};
var IGNORED_NODE_TYPE_IDS = {"Hero" : ["Random", "AI", "_Empty"]};

tiptoe(
	/*function clearOut()
	{
		base.info("Clearing 'out' directory...");
		rimraf(OUT_PATH, this);
	},
	function createOut()
	{
		fs.mkdir(OUT_PATH, this);
	},
	function copyBuildInfo()
	{
		base.info("Copying latest .build.info file...");
		fileUtil.copy(path.join(HOTS_PATH, ".build.info"), path.join(HOTS_DATA_PATH, ".build.info"), this);
	},
	function extractFiles()
	{
		base.info("Extracting needed files...");
		NEEDED_FILE_PATHS.parallelForEach(function(NEEDED_FILE_PATH, subcb)
		{
			runUtil.run(CASCEXTRATOR_PATH, [HOTS_DATA_PATH, "-o", OUT_PATH, "-f", NEEDED_FILE_PATH], {silent:true}, subcb);
		}, this, 10);
	},*/
	function loadDataAndSaveJSON()
	{
		var xmlDocs = [];

		base.info("Loading data...");
		NEEDED_FILE_PATHS.forEach(function(NEEDED_FILE_PATH)
		{
			var diskPath = path.join(OUT_PATH, NEEDED_FILE_PATH.replaceAll("\\\\", "/"));
			if(!fs.existsSync(diskPath))
			{
				base.info("Missing file: %s", NEEDED_FILE_PATH);
				return;
			}
			var fileData = fs.readFileSync(diskPath, {encoding:"utf8"});
			if(diskPath.endsWith("GameStrings.txt"))
			{
				fileData.split("\n").forEach(function(line) {
					S[line.substring(0, line.indexOf("="))] = line.substring(line.indexOf("=")+1).trim();
				});
			}
			else if(diskPath.endsWith(".xml"))
			{
				xmlDocs.push(libxmljs.parseXml(fileData));
			}
		});

		loadMergedNodeMap(xmlDocs);

		var heroes = Object.values(NODE_MAPS["Hero"]).map(function(heroNode) { return processHeroNode(heroNode); });

		base.info("Validating %d heroes...", heroes.length);
		heroes.forEach(validateHero);
		
		base.info("Saving JSON...");

		fs.writeFile(HEROES_OUT_PATH, JSON.stringify(heroes), {encoding:"utf8"}, this);
	},
	/*function cleanup()
	{
		base.info("Cleaning up 'out' directory...");
		rimraf(OUT_MODS_PATH, this);
	},*/
	function finish(err)
	{
		if(err)
		{
			base.error(err);
			process.exit(1);
		}

		base.info("Done.");

		process.exit(0);
	}
);

function loadMergedNodeMap(xmlDocs)
{
	xmlDocs.forEach(function(xmlDoc)
	{
		xmlDoc.find("/Catalog/*").forEach(function(node)
		{
			if(!node.attr("id"))
				return;

			var nodeType = NODE_MAP_TYPES.filter(function(NODE_MAP_TYPE) { return node.name().startsWith("C" + NODE_MAP_TYPE); });
			if(!nodeType || nodeType.length!==1)
				return;

			nodeType = nodeType[0];

			var nodeid = attributeValue(node, "id");
			if(IGNORED_NODE_TYPE_IDS.hasOwnProperty(nodeType) && IGNORED_NODE_TYPE_IDS[nodeType].contains(nodeid))
				return;

			if(!NODE_MAPS[nodeType].hasOwnProperty(nodeid))
			{
				NODE_MAPS[nodeType][nodeid] = node;
				return;
			}

			mergeXML(node, NODE_MAPS[nodeType][nodeid]);
		});
	});
}

function mergeXML(fromNode, toNode)
{
	fromNode.childNodes().forEach(function(childNode)
	{
		if(childNode.name()==="TalentTreeArray")
		{
			var existingChildNode = toNode.get("TalentTreeArray[@Tier='" + attributeValue(childNode, "Tier") + "' and @Column='" + attributeValue(childNode, "Column") + "']");
			if(existingChildNode)
				existingChildNode.remove();
		}

		toNode.addChild(childNode);
	});
}

function processHeroNode(heroNode)
{
	var hero = {};

	// Core hero data
	hero.id = heroNode.attr("id").value();
	hero.name = S["Unit/Name/" + getValue(heroNode, "Unit", "Hero" + hero.id)];

	base.info("Processing hero: %s", hero.name);
	hero.title =  S["Hero/Title/" + hero.id];

	hero.role = getValue(heroNode, "Role");
	if(hero.role==="Damage")
		hero.role = "Assassin";
	if(!hero.role && !!getValue(heroNode, "Melee"))
		hero.role = "Warrior";

	hero.type = !!getValue(heroNode, "Melee") ? "Melee" : "Ranged";
	hero.gender = getValue(heroNode, "Gender", "Male");
	hero.franchise = getValue(heroNode, "Universe", "Starcraft");
	hero.difficulty = getValue(heroNode, "Difficulty", "Easy");
	if(hero.difficulty==="VeryHard")
		hero.difficulty = "Very Hard";

	var ratingsNode = heroNode.get("Ratings");
	if(ratingsNode)
	{
		hero.ratings =
		{
			damage        : +getValue(ratingsNode, "Damage", attributeValue(ratingsNode, "Damage", 1)),
			utility       : +getValue(ratingsNode, "Utility", attributeValue(ratingsNode, "Utility", 1)),
			survivability : +getValue(ratingsNode, "Survivability", attributeValue(ratingsNode, "Survivability", 1)),
			complexity    : +getValue(ratingsNode, "Complexity", attributeValue(ratingsNode, "Complexity", 1)),
		};
	}

	var releaseDateNode = heroNode.get("ReleaseDate");
	if(releaseDateNode)
		hero.releaseDate = moment(attributeValue(releaseDateNode, "Month", 1) + "-" + attributeValue(releaseDateNode, "Day", 1) + "-" + attributeValue(releaseDateNode, "Year", "2014"), "M-D-YYYY").format("YYYY-MM-DD");

	// Level Scaling Info
	HERO_LEVEL_SCALING_MODS[hero.id] = [];

	heroNode.find("LevelScalingArray/Modifications").forEach(function(modNode)
	{
		var modType = getValue(modNode, "Catalog", attributeValue(modNode, "Catalog"));
		if(!NODE_MAP_TYPES.contains(modType))
			throw new Error("Unsupported LevelScalingArray Modification Catalog modType: " + modType);

		var modKey = getValue(modNode, "Entry", attributeValue(modNode, "Entry"));
		if(!modKey)
			throw new Error("No Entry node in LevelScalingArray Modification (" + modKey + ") for hero: " + hero.id);

		var modTarget = getValue(modNode, "Field", attributeValue(modNode, "Field"));
		if(!modTarget)
			throw new Error("No Field node in LevelScalingArray Modification (" + modTarget + ") for hero: " + hero.id);

		var modValue = getValue(modNode, "Value", attributeValue(modNode, "Value"));
		if(!modValue)
			return;

		HERO_LEVEL_SCALING_MODS[hero.id].push({type:modType,key:modKey,target:modTarget,value:(+modValue)});
	});

	// Abilities
	
	/*<HeroAbilArray Abil="NovaSnipeStorm" Button="NovaSnipeHeroSelect">
            <Flags index="ShowInHeroSelect" value="1"/>
            <Flags index="AffectedByCooldownReduction" value="1"/>
            <Flags index="AffectedByOverdrive" value="1"/>
        </HeroAbilArray>
        <HeroAbilArray Abil="NovaPinningShot" Button="NovaPinningShotHeroSelect">
            <Flags index="ShowInHeroSelect" value="1"/>
            <Flags index="AffectedByCooldownReduction" value="1"/>
            <Flags index="AffectedByOverdrive" value="1"/>
        </HeroAbilArray>
        <HeroAbilArray Abil="NovaHoloDecoy" Button="NovaHoloDecoyHeroSelect">
            <Flags index="ShowInHeroSelect" value="1"/>
            <Flags index="AffectedByCooldownReduction" value="1"/>
        </HeroAbilArray>
        <HeroAbilArray Abil="NovaTripleTap" Button="NovaTripleTapHeroSelect">
            <Flags index="ShowInHeroSelect" value="1"/>
            <Flags index="AffectedByCooldownReduction" value="1"/>
            <Flags index="AffectedByOverdrive" value="1"/>
            <Flags index="Heroic" value="1"/>
        </HeroAbilArray>
        <HeroAbilArray Abil="NovaPrecisionStrike" Button="NovaPrecisionStrikeHeroSelect">
            <Flags index="ShowInHeroSelect" value="1"/>
            <Flags index="UsesCharges" value="1"/>
            <Flags index="AffectedByCooldownReduction" value="1"/>
            <Flags index="AffectedByOverdrive" value="1"/>
            <Flags index="Heroic" value="1"/>
        </HeroAbilArray>
        <HeroAbilArray Button="NovaPermanentCloakSniperHeroSelect">
            <Flags index="ShowInHeroSelect" value="1"/>
            <Flags index="Trait" value="1"/>
        </HeroAbilArray>*/

	// Talents
	hero.talents = {};
	C.HERO_TALENT_LEVELS.forEach(function(HERO_TALENT_LEVEL) { hero.talents[HERO_TALENT_LEVEL] = []; });
	var talentTreeNodes = heroNode.find("TalentTreeArray").filter(function(talentTreeNode) { return !!!attributeValue(talentTreeNode, "removed"); });
	talentTreeNodes.sort(function(a, b) { return (+((+attributeValue(a, "Tier"))*10)+(+attributeValue(a, "Column")))-(+((+attributeValue(b, "Tier"))*10)+(+attributeValue(b, "Column"))); });

	talentTreeNodes.forEach(function(talentTreeNode)
	{
		var talent = {};

		talent.id = attributeValue(talentTreeNode, "Talent");

		var talentNode = NODE_MAPS["Talent"][talent.id];
		var faceid = getValue(talentNode, "Face");

		var talentDescription = S["Button/Tooltip/" + faceid];

		if(!talentDescription && faceid==="TyrandeHuntersMarkTrueshotAuraTalent")
			talentDescription = S["Button/Tooltip/TyrandeTrueshotBowTalent"];

		if(!talentDescription)
		{
			base.warn("Missing talent description for hero [%s] and talentid [%s] and faceid [%s]", hero.id, talent.id, faceid);
			return;
		}

		talent.name = talentDescription.replace(/<s val="StandardTooltipHeader">([^<]+)<.+/, "$1").replace(/<s\s*val\s*=\s*"StandardTooltip">/gm, "").trim();
		talentDescription = talentDescription.replace(/<s val="StandardTooltipHeader">[^<]+(<.+)/, "$1").replace(/<s val="StandardTooltip">?(.+)/, "$1");
		talentDescription = talentDescription.replace(/<s val="StandardTooltipHeader">/g, "");

		talent.description = getTalentDescription(talentDescription, hero.id, 0);

		var talentDescriptionLevel1 = getTalentDescription(talentDescription, hero.id, 1);
		if(talent.description!==talentDescriptionLevel1)
		{
			var beforeWords = talent.description.split(" ");
			var afterWords = talentDescriptionLevel1.split(" ");
			if(beforeWords.length!==afterWords.length)
				throw new Error("Talent description words length MISMATCH " + beforeWords.length + " vs " + afterWords.length + " for hero (" + hero.id + ") and talent: " + talent.description);

			var updatedWords = [];
			beforeWords.forEach(function(beforeWord, i)
			{
				var afterWord = afterWords[i];
				if(beforeWord===afterWord)
				{
					updatedWords.push(beforeWord);
					return;
				}

				var endWithPeriod = beforeWord.endsWith(".");
				if(endWithPeriod)
				{
					beforeWord = beforeWord.substring(0, beforeWord.length-1);
					afterWord = afterWord.substring(0, afterWord.length-1);
				}

				var isPercentage = beforeWord.endsWith("%");
				if(isPercentage)
				{
					beforeWord = beforeWord.substring(0, beforeWord.length-1);
					afterWord = afterWord.substring(0, afterWord.length-1);
				}

				var valueDifference = (+afterWord).subtract(+beforeWord);

				var resultWord = beforeWord + (isPercentage ? "%" : "") + " (" + (valueDifference>0 ? "+" : "") + valueDifference + (isPercentage ? "%" : "") + " per level)" + (endWithPeriod ? "." : "");

				//base.info("%d vs %d: %s", beforeWord, afterWord, resultWord);
				updatedWords.push(resultWord);
			});

			talent.description = updatedWords.join(" ");
		}

		var talentPrerequisiteNode = talentTreeNode.get("PrerequisiteTalentArray");
		if(talentPrerequisiteNode)
			talent.prerequisite = attributeValue(talentPrerequisiteNode, "value");

		hero.talents[C.HERO_TALENT_LEVELS[((+attributeValue(talentTreeNode, "Tier"))-1)]].push(talent);
	});
	
	// Final modifications
    performHeroModifications(hero);
	
	return hero;
}

function getTalentDescription(_talentDescription, heroid, heroLevel)
{
	var talentDescription = _talentDescription;

	(talentDescription.match(/<d ref="[^"]+"[^/]*\/>/g) || []).forEach(function(dynamic)
	{
		var formula = dynamic.match(/ref\s*=\s*"([^"]+)"/)[1];
		if(formula.endsWith(")") && !formula.contains("("))
			formula = formula.substring(0, formula.length-1);
		try
		{
			var result = FORMULA_PARSER.parse(formula, {heroid:heroid, heroLevel:heroLevel, lookupXMLRef : lookupXMLRef});
			//if(heroid==="L90ETC") { base.info("Formula: %s\nResult: %d", formula, result); }
		
			var MAX_PRECISION = 4;
			if(result.toFixed(MAX_PRECISION).length<(""+result).length)
				result = +result.toFixed(MAX_PRECISION);

			//var precision = dynamic.match(/precision\s*=\s*"([^"]+)"/) ? +dynamic.match(/precision\s*=\s*"([^"]+)"/)[1] : null;
			//if(precision!==null && Math.floor(result)!==result)
			//	result = result.toFixed(precision);

			talentDescription = talentDescription.replace(dynamic, result);
		}
		catch(err)
		{
			base.error("Failed to parse: %s", formula);
			throw err;
		}

	});

	talentDescription = talentDescription.replace(/<\/?n\/?><\/?n\/?>/g, "\n").replace(/<\/?n\/?>/g, "");
	talentDescription = talentDescription.replace(/<s\s*val\s*=\s*"StandardTooltipDetails">/gm, "").replace(/<s\s*val\s*=\s*"StandardTooltip">/gm, "").replace(/<\/?[cs]\/?>/g, "");
	talentDescription = talentDescription.replace(/<c\s*val\s*=\s*"[^"]+">/gm, "").replace(/<\/?if\/?>/g, "").trim();
	talentDescription = talentDescription.replace(/ [.]/g, ".");

	return talentDescription;
}

function lookupXMLRef(heroid, heroLevel, query, negative)
{
	var result = 0;

	C.XMLREF_REPLACEMENTS.forEach(function(XMLREF_REPLACEMENT)
	{
		if(query===XMLREF_REPLACEMENT.from)
			query = XMLREF_REPLACEMENT.to;
	});

	//if(heroid==="L90ETC") { base.info("QUERY: %s", query); }

	var mainParts = query.split(",");

	if(!NODE_MAP_TYPES.contains(mainParts[0]))
		throw new Error("No valid node map type for XML query: " + query);

	var nodeMap = NODE_MAPS[mainParts[0]];
	if(!nodeMap.hasOwnProperty(mainParts[1]))
	{
		base.warn("No valid id for nodeMapType XML parts: %s", mainParts);
		return result;
	}

	var target = nodeMap[mainParts[1]];

	if(target.childNodes().length===0)
	{
		if(attributeValue(target, "id")!=="Artifact_AP_Base")
			base.warn("No child nodes for nodeMapType XML parts [%s] with xml:", mainParts, target.toString());
		return result;
	}

	var subparts = mainParts[2].split(".");

	var additionalAmount = 0;
	HERO_LEVEL_SCALING_MODS[heroid].forEach(function(HERO_LEVEL_SCALING_MOD)
	{
		if(HERO_LEVEL_SCALING_MOD.type!==mainParts[0])
			return;

		if(HERO_LEVEL_SCALING_MOD.key!==mainParts[1])
			return;

		if(HERO_LEVEL_SCALING_MOD.target!==subparts[0])
			return;

		additionalAmount = heroLevel*HERO_LEVEL_SCALING_MOD.value;
	});

	//if(heroid==="L90ETC") { base.info("Start (negative:%s): %s", negative, subparts); }
	subparts.forEach(function(subpart)
	{
		var xpath = !subpart.match(/\[[0-9]+\]/) ? subpart.replace(/([^[]+)\[([^\]]+)]/, "$1[@index = '$2']") : subpart.replace(/\[([0-9]+)\]/, "[" + (+subpart.match(/\[([0-9]+)\]/)[1]+1) + "]");
		//if(heroid==="L90ETC") { base.info("Next xpath: %s\nCurrent target: %s\n", xpath, target.toString()); }
		var nextTarget = target.get(xpath);
		if(!nextTarget)
			result = +attributeValue(target, xpath);
		target = nextTarget;
	});

	if(target)
		result = +attributeValue(target, "value");

	result += additionalAmount;
	//if(heroid==="L90ETC") { base.info("%s => %d", query, result); }

	if(negative)
		result = result*-1;

	return result;
}

function performHeroModifications(hero)
{
	if(!C.HERO_MODIFICATIONS.hasOwnProperty(hero.id))
		return;

	C.HERO_MODIFICATIONS[hero.id].forEach(function(HERO_MODIFICATION)
	{
		var match = jsonselect.match(HERO_MODIFICATION.path, hero);
		if(!match || match.length<1)
		{
			base.error("Failed to match [%s] to: %s", HERO_MODIFICATION.path, hero);
			return;
		}

		match[0][HERO_MODIFICATION.name] = HERO_MODIFICATION.value;
	});
}

function validateHero(hero)
{
	var validator = jsen(C.HERO_JSON_SCHEMA);
	if(!validator(hero))
	{
		base.warn("Hero %s (%s) has FAILED VALIDATION", hero.id, hero.name);
		base.info(validator.errors);
	}
}

function getValue(node, subnodeName, defaultValue)
{
	var subnode = node.get(subnodeName);
	if(!subnode)
		return defaultValue || undefined;

	return attributeValue(subnode, "value", defaultValue);
}

function attributeValue(node, attrName, defaultValue)
{
	var attr = node.attr(attrName);
	if(!attr)
		return defaultValue || undefined;

	return attr.value();
}