// Parses the development applications at the South Australian City of Victor Harbor web site and
// places them in a database.
//
// Michael Bone
// 21st October 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const didyoumean = require("didyoumean2");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "http://www.victor.sa.gov.au/page.aspx?u=782";
const CommentUrl = "mailto:localgov@victor.sa.gov.au";
// All valid suburb names.
let SuburbNames = null;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
            resolve(database);
        });
    });
}
// Inserts a row in the database if it does not already exist.
async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or replace into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                console.log(`    Saved: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.  Take care to avoid extremely tall elements (because these may otherwise
// be considered as part of all rows and effectively force the return value of this function to
// the same value, regardless of the value of startElement).
function getRowTop(elements, startElement) {
    let top = startElement.y;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y) // check for overlap
            if (getVerticalOverlapPercentage(startElement, element) > 50) // avoids extremely tall elements
                if (element.y < top)
                    top = element.y;
    return top;
}
// Constructs a rectangle based on the intersection of the two specified rectangles.
function intersect(rectangle1, rectangle2) {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}
// Calculates the square of the Euclidean distance between two elements.
function calculateDistance(element1, element2) {
    let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
    let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
    if (point2.x < point1.x - element1.width / 5) // arbitrary overlap factor of 20% (ie. ignore elements that overlap too much in the horizontal direction)
        return Number.MAX_VALUE;
    return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
}
// Determines whether there is vertical overlap between two elements.
function isVerticalOverlap(element1, element2) {
    return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
}
// Gets the percentage of vertical overlap between two elements (0 means no overlap and 100 means
// 100% overlap; and, for example, 20 means that 20% of the second element overlaps somewhere
// with the first element).
function getVerticalOverlapPercentage(element1, element2) {
    let y1 = Math.max(element1.y, element2.y);
    let y2 = Math.min(element1.y + element1.height, element2.y + element2.height);
    return (y2 < y1) ? 0 : (((y2 - y1) * 100) / element2.height);
}
// Gets the element immediately to the right of the specified element (but ignores elements that
// appear after a large horizontal gap).
function getRightElement(elements, element) {
    let closestElement = { text: undefined, confidence: 0, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) && // ensure that there is at least some vertical overlap
            getVerticalOverlapPercentage(element, rightElement) > 50 && // avoid extremely tall elements (ensure at least 50% overlap)
            (rightElement.x > element.x + element.width) && // ensure the element actually is to the right
            (rightElement.x - (element.x + element.width) < 30) && // avoid elements that appear after a large gap (arbitrarily ensure less than a 30 pixel gap horizontally)
            calculateDistance(element, rightElement) < calculateDistance(element, closestElement)) // check if closer than any element encountered so far
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}
// Gets the text to the right in a rectangle, where the rectangle is delineated by the positions
// in which the three specified strings of (case sensitive) text are found.
function getRightText(elements, topLeftText, rightText, bottomText) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.
    let topLeftElement = elements.find(element => element.text.trim() == topLeftText || element.text.trim() == topLeftText + ":");
    let rightElement = (rightText === undefined) ? undefined : elements.find(element => element.text.trim() == rightText || element.text.trim() == rightText + ":");
    let bottomElement = (bottomText === undefined) ? undefined : elements.find(element => element.text.trim() == bottomText || element.text.trim() == bottomText + ":");
    if (topLeftElement === undefined)
        return undefined;
    let x = topLeftElement.x + topLeftElement.width;
    let y = topLeftElement.y;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);
    let bounds = { x: x, y: y, width: width, height: height };
    // Gather together all elements that are at least 50% within the bounding rectangle.
    let intersectingElements = [];
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    // Sort the elements by Y co-ordinate and then by X co-ordinate.
    let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);
    // Join the elements into a single string.
    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Gets the text to the left in a rectangle, where the rectangle is delineated by the positions
// in which the three specified strings of (case sensitive) text are found.
function getLeftText(elements, topRightText, leftText, bottomText) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.
    let topRightElement = elements.find(element => element.text.trim() == topRightText || element.text.trim() == topRightText + ":");
    let leftElement = (leftText === undefined) ? undefined : elements.find(element => element.text.trim() == leftText || element.text.trim() == leftText + ":");
    let bottomElement = (bottomText === undefined) ? undefined : elements.find(element => element.text.trim() == bottomText || element.text.trim() == bottomText + ":");
    if (topRightElement === undefined)
        return undefined;
    let x = (leftElement === undefined) ? 0 : (leftElement.x + leftElement.width);
    let y = topRightElement.y;
    let width = topRightElement.x - x;
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);
    let bounds = { x: x, y: y, width: width, height: height };
    // Gather together all elements that are at least 50% within the bounding rectangle.
    let intersectingElements = [];
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    // Sort the elements by Y co-ordinate and then by X co-ordinate.
    let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);
    // Join the elements into a single string.
    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Gets the text downwards in a rectangle, where the rectangle is delineated by the positions in
// which the three specified strings of (case sensitive) text are found.
function getDownText(elements, topText, rightText, bottomText) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.
    let topElement = elements.find(element => element.text.trim() == topText);
    let rightElement = (rightText === undefined) ? undefined : elements.find(element => element.text.trim() == rightText);
    let bottomElement = (bottomText === undefined) ? undefined : elements.find(element => element.text.trim() == bottomText);
    if (topElement === undefined)
        return undefined;
    let x = topElement.x;
    let y = topElement.y + topElement.height;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);
    let bounds = { x: x, y: y, width: width, height: height };
    // Gather together all elements that are at least 50% within the bounding rectangle.
    let intersectingElements = [];
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    // Sort the elements by Y co-ordinate and then by X co-ordinate.
    let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);
    // Join the elements into a single string.
    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Formats (and corrects) an address.
function formatAddress(address) {
    address = address.trim();
    if (address === "")
        return "";
    // Pop tokens from the end of the array until a valid suburb name is encountered (allowing
    // for a few spelling errors).
    let tokens = address.split(" ");
    let suburbName = null;
    for (let index = 1; index <= 4; index++) {
        let suburbNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        if (suburbNameMatch !== null) {
            suburbName = SuburbNames[suburbNameMatch];
            tokens.splice(-index, index); // remove elements from the end of the array
            break;
        }
    }
    if (suburbName === null) { // suburb name not found (or not recognised)
        console.log(`The state and post code will not be added because the suburb was not recognised: ${address}`);
        return address;
    }
    // Add the suburb name with its state and post code to the street name.
    let streetName = tokens.join(" ").trim();
    return (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim();
}
// Parses the details from the elements associated with a single development application.
function parseApplicationElements(elements, startElement, informationUrl) {
    // Get the application number.
    let applicationNumber = getLeftText(elements, "Application Date:", undefined, "Date Recieved:"); // note that "Recieved" is spelt incorrectly (it should be "Received")
    if (applicationNumber === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application number on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    console.log(`    Found \"${applicationNumber}\".`);
    // Get the description.
    let description = "";
    if (elements.find(element => element.text.trim() === "Valuation:") === undefined)
        description = getDownText(elements, "Development Description", "Fees", "Proposed No. Allotments:");
    else
        description = getDownText(elements, "Development Description", "Fees", "Valuation:");
    // Get the received date.
    let receivedDateText = "";
    if (elements.find(element => element.text.trim() === "Planning Approval:") !== undefined)
        receivedDateText = getRightText(elements, "Date Recieved:", "Subject Land:", "Planning Approval:"); // note that "Recieved" is spelt incorrectly (it should be "Received")
    else if (elements.find(element => element.text.trim() === "Planning Cancelled:") !== undefined)
        receivedDateText = getRightText(elements, "Date Recieved:", "Subject Land:", "Planning Cancelled:"); // note that "Recieved" is spelt incorrectly (it should be "Received")
    else if (elements.find(element => element.text.trim() === "Planning Refused:") !== undefined)
        receivedDateText = getRightText(elements, "Date Recieved:", "Subject Land:", "Planning Refused:"); // note that "Recieved" is spelt incorrectly (it should be "Received")
    let receivedDate = (receivedDateText === undefined) ? undefined : moment(receivedDateText.trim(), "D/MM/YYYY", true);
    // Get the address.
    let address = getDownText(elements, "Subject Land:", "Development Description", undefined);
    if (address === undefined || address.trim() === "" || address.trim().replace(/\s/g, "") === "000") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the address for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    address = formatAddress(address
        .replace(/Victor Harborüvictor Harbor/g, "Victor Harbor")
        .replace(/Avenueüavenue/g, "Avenue")
        .replace(/ü/g, " ")
        .replace(/Ü/g, " ")
        .trim());
    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description.trim() === "") ? "No Description Provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: (receivedDate !== undefined && receivedDate.isValid()) ? receivedDate.format("YYYY-MM-DD") : ""
    };
}
// Finds the start element of each development application on the current PDF page (there are
// typically four development applications on a single page and each development application
// typically begins with the text "Application Date:").
function findStartElements(elements) {
    // Examine all the elements on the page that being with "A" or "a".
    let startElements = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith("a"))) {
        // Extract up to 18 elements to the right of the element that has text starting with the
        // letter "a" (and so may be the start of the "Application Date:" text).  Join together
        // the elements to the right in an attempt to find the best match to "Application Date:".
        let rightElement = element;
        let rightElements = [];
        let matches = [];
        do {
            rightElements.push(rightElement);
            let text = rightElements.map(element => element.text).join("").replace(/\s/g, "").toLowerCase();
            if (text.length >= 18) // stop once the text is too long
                break;
            if (text.length >= 15) { // ignore until the text is close to long enough
                if (text === "applicationdate:")
                    matches.push({ element: rightElement, threshold: 0 });
                else if (didyoumean(text, ["ApplicationDate:"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 1 });
                else if (didyoumean(text, ["ApplicationDate:"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 2 });
            }
            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 10);
        // Chose the best match (if any matches were found).
        if (matches.length > 0) {
            let bestMatch = matches.reduce((previous, current) => (previous === undefined ||
                previous.threshold < current.threshold ||
                (previous.threshold === current.threshold && Math.abs(previous.text.length - "Application Date:".length) <= Math.abs(current.text.length - "Application Date:".length)) ? current : previous), undefined);
            startElements.push(bestMatch.element);
        }
    }
    // Ensure the start elements are sorted in the order that they appear on the page.
    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
    startElements.sort(yComparer);
    return startElements;
}
// Parses a PDF document.
async function parsePdf(url) {
    let developmentApplications = [];
    // Read the PDF.
    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has the details of multiple applications.
    let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        // Construct a text element for each item from the parsed PDF information.
        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
        let elements = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
            // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
            // exaggerated).  The problem seems to be that the height value is too large in some
            // PDFs.  Provide an alternative, more accurate height value by using a calculation
            // based on the transform matrix.
            let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: workaroundHeight };
        });
        // Sort the elements by Y co-ordinate and then by X co-ordinate.
        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);
        // Group the elements into sections based on where the "Application Date" text starts (and
        // other elements the "Application Date" elements line up with horizontally with a margin
        // of error equal to about half the height of the "Application Date" text).
        let applicationElementGroups = [];
        let startElements = findStartElements(elements);
        for (let index = 0; index < startElements.length; index++) {
            // Determine the highest Y co-ordinate of this row and the next row (or the bottom of
            // the current page).  Allow some leeway vertically (add some extra height).
            let startElement = startElements[index];
            let raisedStartElement = {
                text: startElement.text,
                confidence: startElement.confidence,
                x: startElement.x,
                y: startElement.y - startElement.height / 2,
                width: startElement.width,
                height: startElement.height
            };
            let rowTop = getRowTop(elements, raisedStartElement);
            let nextRowTop = (index + 1 < startElements.length) ? getRowTop(elements, startElements[index + 1]) : Number.MAX_VALUE;
            // Extract all elements between the two rows.
            applicationElementGroups.push({ startElement: startElements[index], elements: elements.filter(element => element.y >= rowTop && element.y + element.height < nextRowTop) });
        }
        // Parse the development application from each group of elements (ie. a section of the
        // current page of the PDF document).  If the same application number is encountered a
        // second time add a suffix to the application number so it is unique (and so will be
        // inserted into the database later instead of being ignored).
        for (let applicationElementGroup of applicationElementGroups) {
            let developmentApplication = parseApplicationElements(applicationElementGroup.elements, applicationElementGroup.startElement, url);
            if (developmentApplication !== undefined) {
                let suffix = 0;
                let applicationNumber = developmentApplication.applicationNumber;
                while (developmentApplications
                    .some(otherDevelopmentApplication => otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber &&
                    (otherDevelopmentApplication.address !== developmentApplication.address ||
                        otherDevelopmentApplication.description !== developmentApplication.description ||
                        otherDevelopmentApplication.receivedDate !== developmentApplication.receivedDate)))
                    developmentApplication.applicationNumber = `${applicationNumber} (${++suffix})`; // add a unique suffix
                developmentApplications.push(developmentApplication);
            }
        }
    }
    return developmentApplications;
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Parses the development applications.
async function main() {
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Read the files containing all possible suburb names.
    SuburbNames = {};
    for (let suburb of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        SuburbNames[suburb.split(",")[0]] = suburb.split(",")[1];
    // Retrieve the page that contains the links to the PDFs.
    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    let pdfUrls = [];
    for (let element of $("p a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl);
        if (!pdfUrls.some(url => url === pdfUrl.href)) // avoid duplicates
            pdfUrls.push(pdfUrl.href);
    }
    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }
    // Parse all PDFs found on the page.
    for (let pdfUrl of pdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);
        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsaUdBQWlHO0FBQ2pHLDZCQUE2QjtBQUM3QixFQUFFO0FBQ0YsZUFBZTtBQUNmLG9CQUFvQjtBQUVwQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBQ3pCLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQyxpQ0FBaUM7QUFDakMsb0NBQW9DO0FBQ3BDLDBDQUEwQztBQUUxQyxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFFbEIsTUFBTSwwQkFBMEIsR0FBRyw2Q0FBNkMsQ0FBQztBQUNqRixNQUFNLFVBQVUsR0FBRyxrQ0FBa0MsQ0FBQztBQUl0RCwwQkFBMEI7QUFFMUIsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBRXZCLDhCQUE4QjtBQUU5QixLQUFLLFVBQVUsa0JBQWtCO0lBQzdCLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxRQUFRLEdBQUcsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ25ELFFBQVEsQ0FBQyxTQUFTLENBQUMsR0FBRyxFQUFFO1lBQ3BCLFFBQVEsQ0FBQyxHQUFHLENBQUMsOExBQThMLENBQUMsQ0FBQztZQUM3TSxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDdEIsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUM7QUFFRCw4REFBOEQ7QUFFOUQsS0FBSyxVQUFVLFNBQVMsQ0FBQyxRQUFRLEVBQUUsc0JBQXNCO0lBQ3JELE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxZQUFZLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQyw0REFBNEQsQ0FBQyxDQUFD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