// ==UserScript==
// @name         ShippingManager - Fuel / CO2 Price Forecast Calendar
// @namespace    http://tampermonkey.net/
// @version      3.44
// @description  Embedded forecast calendar with page-flip navigation
// @author       https://github.com/justonlyforyou/
// @order        14
// @match        https://shippingmanager.cc/*
// @grant        none
// @run-at       document-end
// @enabled      false
// @RequireRebelShipMenu true
// @RequireRebelShipStorage true
// @background-job-required true
// ==/UserScript==
/* globals addMenuItem */

(function() {
    'use strict';

    // ============================================
    // DYNAMIC TABLE SIZING (rows only, title stays small)
    // ============================================
    var lastPageHeight = null;
    function applyDynamicStyles(pageHeight) {
        if (lastPageHeight === pageHeight) return;
        lastPageHeight = pageHeight;
        var titleHeight = 16;
        var headerHeight = 18;
        var numRows = 24;
        var availableHeight = pageHeight - titleHeight - headerHeight - 4;
        var rowHeight = Math.floor(availableHeight / numRows);
        var fontSize = Math.max(9, Math.min(14, Math.floor(rowHeight * 0.75)));
        var cellPadding = Math.max(0, Math.floor((rowHeight - fontSize) / 3));

        var el = document.getElementById('forecast-dynamic-styles');
        if (!el) { el = document.createElement('style'); el.id = 'forecast-dynamic-styles'; document.head.appendChild(el); }
        el.textContent = '\n            .forecast-page-content h2 { font-size: 13px !important; margin: 2px 0 !important; line-height: 1.1 !important; color: #fff !important; }\n            .forecast-table { font-size: ' + fontSize + 'px !important; line-height: 1.1 !important; }\n            .forecast-table th { font-size: ' + Math.max(8, fontSize - 2) + 'px !important; padding: ' + cellPadding + 'px 8px !important; }\n            .forecast-table td { padding: ' + cellPadding + 'px 8px !important; }\n        ';
    }


    // ============================================
    // FORECAST DATA URL
    // ============================================
    var FORECAST_DATA_URL = 'https://shippingmanager-forecast.pages.dev/data/forecast.json';

    // ============================================
    // EMBEDDED PAGEFLIP LIBRARY (minified third-party)
    // ============================================
    /* eslint-disable */
    !function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t=t||self).St={})}(this,(function(t){"use strict";class e{constructor(t,e){this.state={angle:0,area:[],position:{x:0,y:0},hardAngle:0,hardDrawingAngle:0},this.createdDensity=e,this.nowDrawingDensity=this.createdDensity,this.render=t}setDensity(t){this.createdDensity=t,this.nowDrawingDensity=t}setDrawingDensity(t){this.nowDrawingDensity=t}setPosition(t){this.state.position=t}setAngle(t){this.state.angle=t}setArea(t){this.state.area=t}setHardDrawingAngle(t){this.state.hardDrawingAngle=t}setHardAngle(t){this.state.hardAngle=t,this.state.hardDrawingAngle=t}setOrientation(t){this.orientation=t}getDrawingDensity(){return this.nowDrawingDensity}getDensity(){return this.createdDensity}getHardAngle(){return this.state.hardAngle}}class i extends e{constructor(t,e,i){super(t,i),this.image=null,this.isLoad=!1,this.loadingAngle=0,this.image=new Image,this.image.src=e}draw(t){const e=this.render.getContext(),i=this.render.convertToGlobal(this.state.position),s=this.render.getRect().pageWidth,n=this.render.getRect().height;e.save(),e.translate(i.x,i.y),e.beginPath();for(let t of this.state.area)null!==t&&(t=this.render.convertToGlobal(t),e.lineTo(t.x-i.x,t.y-i.y));e.rotate(this.state.angle),e.clip(),this.isLoad?e.drawImage(this.image,0,0,s,n):this.drawLoader(e,{x:0,y:0},s,n),e.restore()}simpleDraw(t){const e=this.render.getRect(),i=this.render.getContext(),s=e.pageWidth,n=e.height,h=1===t?e.left+e.pageWidth:e.left,r=e.top;this.isLoad?i.drawImage(this.image,h,r,s,n):this.drawLoader(i,{x:h,y:r},s,n)}drawLoader(t,e,i,s){t.beginPath(),t.strokeStyle="rgb(200, 200, 200)",t.fillStyle="rgb(255, 255, 255)",t.lineWidth=1,t.rect(e.x+1,e.y+1,i-1,s-1),t.stroke(),t.fill();const n={x:e.x+i/2,y:e.y+s/2};t.beginPath(),t.lineWidth=10,t.arc(n.x,n.y,20,this.loadingAngle,3*Math.PI/2+this.loadingAngle),t.stroke(),t.closePath(),this.loadingAngle+=.07,this.loadingAngle>=2*Math.PI&&(this.loadingAngle=0)}load(){this.isLoad||(this.image.onload=()=>{this.isLoad=!0})}newTemporaryCopy(){return this}getTemporaryCopy(){return this}hideTemporaryCopy(){}}class s{constructor(t,e){this.pages=[],this.currentPageIndex=0,this.currentSpreadIndex=0,this.landscapeSpread=[],this.portraitSpread=[],this.render=e,this.app=t,this.currentPageIndex=0,this.isShowCover=this.app.getSettings().showCover}destroy(){this.pages=[]}createSpread(){this.landscapeSpread=[],this.portraitSpread=[];for(let t=0;t<this.pages.length;t++)this.portraitSpread.push([t]);let t=0;this.isShowCover&&(this.pages[0].setDensity("hard"),this.landscapeSpread.push([t]),t++);for(let e=t;e<this.pages.length;e+=2)e<this.pages.length-1?this.landscapeSpread.push([e,e+1]):(this.landscapeSpread.push([e]),this.pages[e].setDensity("hard"))}getSpread(){return"landscape"===this.render.getOrientation()?this.landscapeSpread:this.portraitSpread}getSpreadIndexByPage(t){const e=this.getSpread();for(let i=0;i<e.length;i++)if(t===e[i][0]||t===e[i][1])return i;return null}getPageCount(){return this.pages.length}getPages(){return this.pages}getPage(t){if(t>=0&&t<this.pages.length)return this.pages[t];throw new Error("Invalid page number")}nextBy(t){const e=this.pages.indexOf(t);return e<this.pages.length-1?this.pages[e+1]:null}prevBy(t){const e=this.pages.indexOf(t);return e>0?this.pages[e-1]:null}getFlippingPage(t){const e=this.currentSpreadIndex;if("portrait"===this.render.getOrientation())return 0===t?this.pages[e].newTemporaryCopy():this.pages[e-1];{const i=0===t?this.getSpread()[e+1]:this.getSpread()[e-1];return 1===i.length||0===t?this.pages[i[0]]:this.pages[i[1]]}}getBottomPage(t){const e=this.currentSpreadIndex;if("portrait"===this.render.getOrientation())return 0===t?this.pages[e+1]:this.pages[e-1];{const i=0===t?this.getSpread()[e+1]:this.getSpread()[e-1];return 1===i.length?this.pages[i[0]]:0===t?this.pages[i[1]]:this.pages[i[0]]}}showNext(){this.currentSpreadIndex<this.getSpread().length&&(this.currentSpreadIndex++,this.showSpread())}showPrev(){this.currentSpreadIndex>0&&(this.currentSpreadIndex--,this.showSpread())}getCurrentPageIndex(){return this.currentPageIndex}show(t=null){if(null===t&&(t=this.currentPageIndex),t<0||t>=this.pages.length)return;const e=this.getSpreadIndexByPage(t);null!==e&&(this.currentSpreadIndex=e,this.showSpread())}getCurrentSpreadIndex(){return this.currentSpreadIndex}setCurrentSpreadIndex(t){if(!(t>=0&&t<this.getSpread().length))throw new Error("Invalid page");this.currentSpreadIndex=t}showSpread(){const t=this.getSpread()[this.currentSpreadIndex];2===t.length?(this.render.setLeftPage(this.pages[t[0]]),this.render.setRightPage(this.pages[t[1]])):"landscape"===this.render.getOrientation()&&t[0]===this.pages.length-1?(this.render.setLeftPage(this.pages[t[0]]),this.render.setRightPage(null)):(this.render.setLeftPage(null),this.render.setRightPage(this.pages[t[0]])),this.currentPageIndex=t[0],this.app.updatePageIndex(this.currentPageIndex)}}class n extends s{constructor(t,e,i){super(t,e),this.imagesHref=i}load(){for(const t of this.imagesHref){const e=new i(this.render,t,"soft");e.load(),this.pages.push(e)}this.createSpread()}}class h{static GetDistanceBetweenTwoPoint(t,e){return null===t||null===e?1/0:Math.sqrt(Math.pow(e.x-t.x,2)+Math.pow(e.y-t.y,2))}static GetSegmentLength(t){return h.GetDistanceBetweenTwoPoint(t[0],t[1])}static GetAngleBetweenTwoLine(t,e){const i=t[0].y-t[1].y,s=e[0].y-e[1].y,n=t[1].x-t[0].x,h=e[1].x-e[0].x;return Math.acos((i*s+n*h)/(Math.sqrt(i*i+n*n)*Math.sqrt(s*s+h*h)))}static PointInRect(t,e){return null===e?null:e.x>=t.left&&e.x<=t.width+t.left&&e.y>=t.top&&e.y<=t.top+t.height?e:null}static GetRotatedPoint(t,e,i){return{x:t.x*Math.cos(i)+t.y*Math.sin(i)+e.x,y:t.y*Math.cos(i)-t.x*Math.sin(i)+e.y}}static LimitPointToCircle(t,e,i){if(h.GetDistanceBetweenTwoPoint(t,i)<=e)return i;const s=t.x,n=t.y,r=i.x,o=i.y;let a=Math.sqrt(Math.pow(e,2)*Math.pow(s-r,2)/(Math.pow(s-r,2)+Math.pow(n-o,2)))+s;i.x<0&&(a*=-1);let g=(a-s)*(n-o)/(s-r)+n;return s-r+n===0&&(g=e),{x:a,y:g}}static GetIntersectBetweenTwoSegment(t,e,i){return h.PointInRect(t,h.GetIntersectBeetwenTwoLine(e,i))}static GetIntersectBeetwenTwoLine(t,e){const i=t[0].y-t[1].y,s=e[0].y-e[1].y,n=t[1].x-t[0].x,h=e[1].x-e[0].x,r=t[0].x*t[1].y-t[1].x*t[0].y,o=e[0].x*e[1].y-e[1].x*e[0].y,a=i*o-s*r,g=n*o-h*r,l=-(r*h-o*n)/(i*h-s*n),d=-(i*o-s*r)/(i*h-s*n);if(isFinite(l)&&isFinite(d))return{x:l,y:d};if(Math.abs(a-g)<.1)throw new Error("Segment included");return null}static GetCordsFromTwoPoint(t,e){const i=Math.abs(t.x-e.x),s=Math.abs(t.y-e.y),n=Math.max(i,s),h=[t];function r(t,e,i,s,n){return e>t?t+n*(i/s):e<t?t-n*(i/s):t}for(let o=1;o<=n;o+=1)h.push({x:r(t.x,e.x,i,n,o),y:r(t.y,e.y,s,n,o)});return h}}class r extends e{constructor(t,e,i){super(t,i),this.copiedElement=null,this.temporaryCopy=null,this.isLoad=!1,this.element=e,this.element.classList.add("stf__item"),this.element.classList.add("--"+i)}newTemporaryCopy(){return"hard"===this.nowDrawingDensity?this:(null===this.temporaryCopy&&(this.copiedElement=this.element.cloneNode(!0),this.element.parentElement.appendChild(this.copiedElement),this.temporaryCopy=new r(this.render,this.copiedElement,this.nowDrawingDensity)),this.getTemporaryCopy())}getTemporaryCopy(){return this.temporaryCopy}hideTemporaryCopy(){null!==this.temporaryCopy&&(this.copiedElement.remove(),this.copiedElement=null,this.temporaryCopy=null)}draw(t){const e=t||this.nowDrawingDensity,i=this.render.convertToGlobal(this.state.position),s=this.render.getRect().pageWidth,n=this.render.getRect().height;this.element.classList.remove("--simple");const h=`\n            display: block;\n            z-index: ${this.element.style.zIndex};\n            left: 0;\n            top: 0;\n            width: ${s}px;\n            height: ${n}px;\n        `;"hard"===e?this.drawHard(h):this.drawSoft(i,h)}drawHard(t=""){const e=this.render.getRect().left+this.render.getRect().width/2,i=this.state.hardDrawingAngle,s=t+"\n                backface-visibility: hidden;\n                -webkit-backface-visibility: hidden;\n                clip-path: none;\n                -webkit-clip-path: none;\n            "+(0===this.orientation?`transform-origin: ${this.render.getRect().pageWidth}px 0; \n                   transform: translate3d(0, 0, 0) rotateY(${i}deg);`:`transform-origin: 0 0; \n                   transform: translate3d(${e}px, 0, 0) rotateY(${i}deg);`);this.element.style.cssText=s}drawSoft(t,e=""){let i="polygon( ";for(const t of this.state.area)if(null!==t){let e=1===this.render.getDirection()?{x:-t.x+this.state.position.x,y:t.y-this.state.position.y}:{x:t.x-this.state.position.x,y:t.y-this.state.position.y};e=h.GetRotatedPoint(e,{x:0,y:0},this.state.angle),i+=e.x+"px "+e.y+"px, "}i=i.slice(0,-2),i+=")";const s=e+`transform-origin: 0 0; clip-path: ${i}; -webkit-clip-path: ${i};`+(this.render.isSafari()&&0===this.state.angle?`transform: translate(${t.x}px, ${t.y}px);`:`transform: translate3d(${t.x}px, ${t.y}px, 0) rotate(${this.state.angle}rad);`);this.element.style.cssText=s}simpleDraw(t){const e=this.render.getRect(),i=e.pageWidth,s=e.height,n=1===t?e.left+e.pageWidth:e.left,h=e.top;this.element.classList.add("--simple"),this.element.style.cssText=`\n            position: absolute; \n            display: block; \n            height: ${s}px; \n            left: ${n}px; \n            top: ${h}px; \n            width: ${i}px; \n            z-index: ${this.render.getSettings().startZIndex+1};`}getElement(){return this.element}load(){this.isLoad=!0}setOrientation(t){super.setOrientation(t),this.element.classList.remove("--left","--right"),this.element.classList.add(1===t?"--right":"--left")}setDrawingDensity(t){this.element.classList.remove("--soft","--hard"),this.element.classList.add("--"+t),super.setDrawingDensity(t)}}class o extends s{constructor(t,e,i,s){super(t,e),this.element=i,this.pagesElement=s}load(){for(const t of this.pagesElement){const e=new r(this.render,t,"hard"===t.dataset.density?"hard":"soft");e.load(),this.pages.push(e)}this.createSpread()}}class a{constructor(t,e,i,s){this.direction=t,this.corner=e,this.topIntersectPoint=null,this.sideIntersectPoint=null,this.bottomIntersectPoint=null,this.pageWidth=parseInt(i,10),this.pageHeight=parseInt(s,10)}calc(t){try{return this.position=this.calcAngleAndPosition(t),this.calculateIntersectPoint(this.position),!0}catch(t){return!1}}getFlippingClipArea(){const t=[];let e=!1;return t.push(this.rect.topLeft),t.push(this.topIntersectPoint),null===this.sideIntersectPoint?e=!0:(t.push(this.sideIntersectPoint),null===this.bottomIntersectPoint&&(e=!1)),t.push(this.bottomIntersectPoint),(e||"bottom"===this.corner)&&t.push(this.rect.bottomLeft),t}getBottomClipArea(){const t=[];return t.push(this.topIntersectPoint),"top"===this.corner?t.push({x:this.pageWidth,y:0}):(null!==this.topIntersectPoint&&t.push({x:this.pageWidth,y:0}),t.push({x:this.pageWidth,y:this.pageHeight})),null!==this.sideIntersectPoint?h.GetDistanceBetweenTwoPoint(this.sideIntersectPoint,this.topIntersectPoint)>=10&&t.push(this.sideIntersectPoint):"top"===this.corner&&t.push({x:this.pageWidth,y:this.pageHeight}),t.push(this.bottomIntersectPoint),t.push(this.topIntersectPoint),t}getAngle(){return 0===this.direction?-this.angle:this.angle}getRect(){return this.rect}getPosition(){return this.position}getActiveCorner(){return 0===this.direction?this.rect.topLeft:this.rect.topRight}getDirection(){return this.direction}getFlippingProgress(){return Math.abs((this.position.x-this.pageWidth)/(2*this.pageWidth)*100)}getCorner(){return this.corner}getBottomPagePosition(){return 1===this.direction?{x:this.pageWidth,y:0}:{x:0,y:0}}getShadowStartPoint(){return"top"===this.corner?this.topIntersectPoint:null!==this.sideIntersectPoint?this.sideIntersectPoint:this.topIntersectPoint}getShadowAngle(){const t=h.GetAngleBetweenTwoLine(this.getSegmentToShadowLine(),[{x:0,y:0},{x:this.pageWidth,y:0}]);return 0===this.direction?t:Math.PI-t}calcAngleAndPosition(t){let e=t;if(this.updateAngleAndGeometry(e),e="top"===this.corner?this.checkPositionAtCenterLine(e,{x:0,y:0},{x:0,y:this.pageHeight}):this.checkPositionAtCenterLine(e,{x:0,y:this.pageHeight},{x:0,y:0}),Math.abs(e.x-this.pageWidth)<1&&Math.abs(e.y)<1)throw new Error("Point is too small");return e}updateAngleAndGeometry(t){this.angle=this.calculateAngle(t),this.rect=this.getPageRect(t)}calculateAngle(t){const e=this.pageWidth-t.x+1,i="bottom"===this.corner?this.pageHeight-t.y:t.y;let s=2*Math.acos(e/Math.sqrt(i*i+e*e));i<0&&(s=-s);const n=Math.PI-s;if(!isFinite(s)||n>=0&&n<.003)throw new Error("The G point is too small");return"bottom"===this.corner&&(s=-s),s}getPageRect(t){return"top"===this.corner?this.getRectFromBasePoint([{x:0,y:0},{x:this.pageWidth,y:0},{x:0,y:this.pageHeight},{x:this.pageWidth,y:this.pageHeight}],t):this.getRectFromBasePoint([{x:0,y:-this.pageHeight},{x:this.pageWidth,y:-this.pageHeight},{x:0,y:0},{x:this.pageWidth,y:0}],t)}getRectFromBasePoint(t,e){return{topLeft:this.getRotatedPoint(t[0],e),topRight:this.getRotatedPoint(t[1],e),bottomLeft:this.getRotatedPoint(t[2],e),bottomRight:this.getRotatedPoint(t[3],e)}}getRotatedPoint(t,e){return{x:t.x*Math.cos(this.angle)+t.y*Math.sin(this.angle)+e.x,y:t.y*Math.cos(this.angle)-t.x*Math.sin(this.angle)+e.y}}calculateIntersectPoint(t){const e={left:-1,top:-1,width:this.pageWidth+2,height:this.pageHeight+2};"top"===this.corner?(this.topIntersectPoint=h.GetIntersectBetweenTwoSegment(e,[t,this.rect.topRight],[{x:0,y:0},{x:this.pageWidth,y:0}]),this.sideIntersectPoint=h.GetIntersectBetweenTwoSegment(e,[t,this.rect.bottomLeft],[{x:this.pageWidth,y:0},{x:this.pageWidth,y:this.pageHeight}]),this.bottomIntersectPoint=h.GetIntersectBetweenTwoSegment(e,[this.rect.bottomLeft,this.rect.bottomRight],[{x:0,y:this.pageHeight},{x:this.pageWidth,y:this.pageHeight}])):(this.topIntersectPoint=h.GetIntersectBetweenTwoSegment(e,[this.rect.topLeft,this.rect.topRight],[{x:0,y:0},{x:this.pageWidth,y:0}]),this.sideIntersectPoint=h.GetIntersectBetweenTwoSegment(e,[t,this.rect.topLeft],[{x:this.pageWidth,y:0},{x:this.pageWidth,y:this.pageHeight}]),this.bottomIntersectPoint=h.GetIntersectBetweenTwoSegment(e,[this.rect.bottomLeft,this.rect.bottomRight],[{x:0,y:this.pageHeight},{x:this.pageWidth,y:this.pageHeight}]))}checkPositionAtCenterLine(t,e,i){let s=t;const n=h.LimitPointToCircle(e,this.pageWidth,s);s!==n&&(s=n,this.updateAngleAndGeometry(s));const r=Math.sqrt(Math.pow(this.pageWidth,2)+Math.pow(this.pageHeight,2));let o=this.rect.bottomRight,a=this.rect.topLeft;if("bottom"===this.corner&&(o=this.rect.topRight,a=this.rect.bottomLeft),o.x<=0){const t=h.LimitPointToCircle(i,r,a);t!==s&&(s=t,this.updateAngleAndGeometry(s))}return s}getSegmentToShadowLine(){const t=this.getShadowStartPoint();return[t,t!==this.sideIntersectPoint&&null!==this.sideIntersectPoint?this.sideIntersectPoint:this.bottomIntersectPoint]}}class g{constructor(t,e){this.flippingPage=null,this.bottomPage=null,this.calc=null,this.state="read",this.render=t,this.app=e}fold(t){this.setState("user_fold"),null===this.calc&&this.start(t),this.do(this.render.convertToPage(t))}flip(t){if(this.app.getSettings().disableFlipByClick&&!this.isPointOnCorners(t))return;if(null!==this.calc&&this.render.finishAnimation(),!this.start(t))return;const e=this.getBoundsRect();this.setState("flipping");const i=e.height/10,s="bottom"===this.calc.getCorner()?e.height-i:i,n="bottom"===this.calc.getCorner()?e.height:0;this.calc.calc({x:e.pageWidth-i,y:s}),this.animateFlippingTo({x:e.pageWidth-i,y:s},{x:-e.pageWidth,y:n},!0)}start(t){this.reset();const e=this.render.convertToBook(t),i=this.getBoundsRect(),s=this.getDirectionByPoint(e),n=e.y>=i.height/2?"bottom":"top";if(!this.checkDirection(s))return!1;try{if(this.flippingPage=this.app.getPageCollection().getFlippingPage(s),this.bottomPage=this.app.getPageCollection().getBottomPage(s),"landscape"===this.render.getOrientation())if(1===s){const t=this.app.getPageCollection().nextBy(this.flippingPage);null!==t&&this.flippingPage.getDensity()!==t.getDensity()&&(this.flippingPage.setDrawingDensity("hard"),t.setDrawingDensity("hard"))}else{const t=this.app.getPageCollection().prevBy(this.flippingPage);null!==t&&this.flippingPage.getDensity()!==t.getDensity()&&(this.flippingPage.setDrawingDensity("hard"),t.setDrawingDensity("hard"))}return this.render.setDirection(s),this.calc=new a(s,n,i.pageWidth.toString(10),i.height.toString(10)),!0}catch(t){return!1}}do(t){if(null!==this.calc&&this.calc.calc(t)){const t=this.calc.getFlippingProgress();this.bottomPage.setArea(this.calc.getBottomClipArea()),this.bottomPage.setPosition(this.calc.getBottomPagePosition()),this.bottomPage.setAngle(0),this.bottomPage.setHardAngle(0),this.flippingPage.setArea(this.calc.getFlippingClipArea()),this.flippingPage.setPosition(this.calc.getActiveCorner()),this.flippingPage.setAngle(this.calc.getAngle()),0===this.calc.getDirection()?this.flippingPage.setHardAngle(90*(200-2*t)/100):this.flippingPage.setHardAngle(-90*(200-2*t)/100),this.render.setPageRect(this.calc.getRect()),this.render.setBottomPage(this.bottomPage),this.render.setFlippingPage(this.flippingPage),this.render.setShadowData(this.calc.getShadowStartPoint(),this.calc.getShadowAngle(),t,this.calc.getDirection())}}flipToPage(t,e){const i=this.app.getPageCollection().getCurrentSpreadIndex(),s=this.app.getPageCollection().getSpreadIndexByPage(t);try{s>i&&(this.app.getPageCollection().setCurrentSpreadIndex(s-1),this.flipNext(e)),s<i&&(this.app.getPageCollection().setCurrentSpreadIndex(s+1),this.flipPrev(e))}catch(t){}}flipNext(t){this.flip({x:this.render.getRect().left+2*this.render.getRect().pageWidth-10,y:"top"===t?1:this.render.getRect().height-2})}flipPrev(t){this.flip({x:10,y:"top"===t?1:this.render.getRect().height-2})}stopMove(){if(null===this.calc)return;const t=this.calc.getPosition(),e=this.getBoundsRect(),i="bottom"===this.calc.getCorner()?e.height:0;t.x<=0?this.animateFlippingTo(t,{x:-e.pageWidth,y:i},!0):this.animateFlippingTo(t,{x:e.pageWidth,y:i},!1)}showCorner(t){if(!this.checkState("read","fold_corner"))return;const e=this.getBoundsRect(),i=e.pageWidth;if(this.isPointOnCorners(t))if(null===this.calc){if(!this.start(t))return;this.setState("fold_corner"),this.calc.calc({x:i-1,y:1});const s=50,n="bottom"===this.calc.getCorner()?e.height-1:1,h="bottom"===this.calc.getCorner()?e.height-s:s;this.animateFlippingTo({x:i-1,y:n},{x:i-s,y:h},!1,!1)}else this.do(this.render.convertToPage(t));else this.setState("read"),this.render.finishAnimation(),this.stopMove()}animateFlippingTo(t,e,i,s=!0){const n=h.GetCordsFromTwoPoint(t,e),r=[];for(const t of n)r.push(()=>this.do(t));const o=this.getAnimationDuration(n.length);this.render.startAnimation(r,o,()=>{this.calc&&(i&&(1===this.calc.getDirection()?this.app.turnToPrevPage():this.app.turnToNextPage()),s&&(this.render.setBottomPage(null),this.render.setFlippingPage(null),this.render.clearShadow(),this.setState("read"),this.reset()))})}getCalculation(){return this.calc}getState(){return this.state}setState(t){this.state!==t&&(this.app.updateState(t),this.state=t)}getDirectionByPoint(t){const e=this.getBoundsRect();if("portrait"===this.render.getOrientation()){if(t.x-e.pageWidth<=e.width/2)return 1}else if(t.x<e.width/2)return 1;return 0}getAnimationDuration(t){const e=this.app.getSettings().flippingTime;return t>=1e3?e:t/1e3*e}checkDirection(t){return 0===t?this.app.getCurrentPageIndex()<this.app.getPageCount()-1:this.app.getCurrentPageIndex()>=1}reset(){this.calc=null,this.flippingPage=null,this.bottomPage=null}getBoundsRect(){return this.render.getRect()}checkState(...t){for(const e of t)if(this.state===e)return!0;return!1}isPointOnCorners(t){const e=this.getBoundsRect(),i=e.pageWidth,s=Math.sqrt(Math.pow(i,2)+Math.pow(e.height,2))/2,n=this.render.convertToBook(t);return n.x>0&&n.y>0&&n.x<e.width&&n.y<e.height&&(n.x<s||n.x>e.width-s)&&(n.y<s||n.y>e.height-s)}}class l{constructor(t,e){this.leftPage=null,this.rightPage=null,this.flippingPage=null,this.bottomPage=null,this.direction=null,this.orientation=null,this.shadow=null,this.animation=null,this.pageRect=null,this.boundsRect=null,this.timer=0,this.safari=!1,this.setting=e,this.app=t;const i=new RegExp("Version\\/[\\d\\.]+.*Safari/");this.safari=null!==i.exec(window.navigator.userAgent)}render(t){if(null!==this.animation){const e=Math.round((t-this.animation.startedAt)/this.animation.durationFrame);e<this.animation.frames.length?this.animation.frames[e]():(this.animation.onAnimateEnd(),this.animation=null)}this.timer=t,this.drawFrame()}start(){this.update();const t=e=>{this.render(e),requestAnimationFrame(t)};requestAnimationFrame(t)}startAnimation(t,e,i){this.finishAnimation(),this.animation={frames:t,duration:e,durationFrame:e/t.length,onAnimateEnd:i,startedAt:this.timer}}finishAnimation(){null!==this.animation&&(this.animation.frames[this.animation.frames.length-1](),null!==this.animation.onAnimateEnd&&this.animation.onAnimateEnd()),this.animation=null}update(){this.boundsRect=null;const t=this.calculateBoundsRect();this.orientation!==t&&(this.orientation=t,this.app.updateOrientation(t))}calculateBoundsRect(){let t="landscape";const e=this.getBlockWidth(),i=e/2,s=this.getBlockHeight()/2,n=this.setting.width/this.setting.height;let h=this.setting.width,r=this.setting.height,o=i-h;return"stretch"===this.setting.size?(e<2*this.setting.minWidth&&this.app.getSettings().usePortrait&&(t="portrait"),h="portrait"===t?this.getBlockWidth():this.getBlockWidth()/2,h>this.setting.maxWidth&&(h=this.setting.maxWidth),r=h/n,r>this.getBlockHeight()&&(r=this.getBlockHeight(),h=r*n),o="portrait"===t?i-h/2-h:i-h):e<2*h&&this.app.getSettings().usePortrait&&(t="portrait",o=i-h/2-h),this.boundsRect={left:o,top:s-r/2,width:2*h,height:r,pageWidth:h},t}setShadowData(t,e,i,s){if(!this.app.getSettings().drawShadow)return;const n=100*this.getSettings().maxShadowOpacity;this.shadow={pos:t,angle:e,width:3*this.getRect().pageWidth/4*i/100,opacity:(100-i)*n/100/100,direction:s,progress:2*i}}clearShadow(){this.shadow=null}getBlockWidth(){return this.app.getUI().getDistElement().offsetWidth}getBlockHeight(){return this.app.getUI().getDistElement().offsetHeight}getDirection(){return this.direction}getRect(){return null===this.boundsRect&&this.calculateBoundsRect(),this.boundsRect}getSettings(){return this.app.getSettings()}getOrientation(){return this.orientation}setPageRect(t){this.pageRect=t}setDirection(t){this.direction=t}setRightPage(t){null!==t&&t.setOrientation(1),this.rightPage=t}setLeftPage(t){null!==t&&t.setOrientation(0),this.leftPage=t}setBottomPage(t){null!==t&&t.setOrientation(1===this.direction?0:1),this.bottomPage=t}setFlippingPage(t){null!==t&&t.setOrientation(0===this.direction&&"portrait"!==this.orientation?0:1),this.flippingPage=t}convertToBook(t){const e=this.getRect();return{x:t.x-e.left,y:t.y-e.top}}isSafari(){return this.safari}convertToPage(t,e){e||(e=this.direction);const i=this.getRect();return{x:0===e?t.x-i.left-i.width/2:i.width/2-t.x+i.left,y:t.y-i.top}}convertToGlobal(t,e){if(e||(e=this.direction),null==t)return null;const i=this.getRect();return{x:0===e?t.x+i.left+i.width/2:i.width/2-t.x+i.left,y:t.y+i.top}}convertRectToGlobal(t,e){return e||(e=this.direction),{topLeft:this.convertToGlobal(t.topLeft,e),topRight:this.convertToGlobal(t.topRight,e),bottomLeft:this.convertToGlobal(t.bottomLeft,e),bottomRight:this.convertToGlobal(t.bottomRight,e)}}}class d extends l{constructor(t,e,i){super(t,e),this.canvas=i,this.ctx=i.getContext("2d")}getContext(){return this.ctx}reload(){}drawFrame(){this.clear(),"portrait"!==this.orientation&&null!=this.leftPage&&this.leftPage.simpleDraw(0),null!=this.rightPage&&this.rightPage.simpleDraw(1),null!=this.bottomPage&&this.bottomPage.draw(),this.drawBookShadow(),null!=this.flippingPage&&this.flippingPage.draw(),null!=this.shadow&&(this.drawOuterShadow(),this.drawInnerShadow());const t=this.getRect();"portrait"===this.orientation&&(this.ctx.beginPath(),this.ctx.rect(t.left+t.pageWidth,t.top,t.width,t.height),this.ctx.clip())}drawBookShadow(){const t=this.getRect();this.ctx.save(),this.ctx.beginPath();const e=t.width/20;this.ctx.rect(t.left,t.top,t.width,t.height);const i={x:t.left+t.width/2-e/2,y:0};this.ctx.translate(i.x,i.y);const s=this.ctx.createLinearGradient(0,0,e,0);s.addColorStop(0,"rgba(0, 0, 0, 0)"),s.addColorStop(.4,"rgba(0, 0, 0, 0.2)"),s.addColorStop(.49,"rgba(0, 0, 0, 0.1)"),s.addColorStop(.5,"rgba(0, 0, 0, 0.5)"),s.addColorStop(.51,"rgba(0, 0, 0, 0.4)"),s.addColorStop(1,"rgba(0, 0, 0, 0)"),this.ctx.clip(),this.ctx.fillStyle=s,this.ctx.fillRect(0,0,e,2*t.height),this.ctx.restore()}drawOuterShadow(){const t=this.getRect();this.ctx.save(),this.ctx.beginPath(),this.ctx.rect(t.left,t.top,t.width,t.height);const e=this.convertToGlobal({x:this.shadow.pos.x,y:this.shadow.pos.y});this.ctx.translate(e.x,e.y),this.ctx.rotate(Math.PI+this.shadow.angle+Math.PI/2);const i=this.ctx.createLinearGradient(0,0,this.shadow.width,0);0===this.shadow.direction?(this.ctx.translate(0,-100),i.addColorStop(0,"rgba(0, 0, 0, "+this.shadow.opacity+")"),i.addColorStop(1,"rgba(0, 0, 0, 0)")):(this.ctx.translate(-this.shadow.width,-100),i.addColorStop(0,"rgba(0, 0, 0, 0)"),i.addColorStop(1,"rgba(0, 0, 0, "+this.shadow.opacity+")")),this.ctx.clip(),this.ctx.fillStyle=i,this.ctx.fillRect(0,0,this.shadow.width,2*t.height),this.ctx.restore()}drawInnerShadow(){const t=this.getRect();this.ctx.save(),this.ctx.beginPath();const e=this.convertToGlobal({x:this.shadow.pos.x,y:this.shadow.pos.y}),i=this.convertRectToGlobal(this.pageRect);this.ctx.moveTo(i.topLeft.x,i.topLeft.y),this.ctx.lineTo(i.topRight.x,i.topRight.y),this.ctx.lineTo(i.bottomRight.x,i.bottomRight.y),this.ctx.lineTo(i.bottomLeft.x,i.bottomLeft.y),this.ctx.translate(e.x,e.y),this.ctx.rotate(Math.PI+this.shadow.angle+Math.PI/2);const s=3*this.shadow.width/4,n=this.ctx.createLinearGradient(0,0,s,0);0===this.shadow.direction?(this.ctx.translate(-s,-100),n.addColorStop(1,"rgba(0, 0, 0, "+this.shadow.opacity+")"),n.addColorStop(.9,"rgba(0, 0, 0, 0.05)"),n.addColorStop(.7,"rgba(0, 0, 0, "+this.shadow.opacity+")"),n.addColorStop(0,"rgba(0, 0, 0, 0)")):(this.ctx.translate(0,-100),n.addColorStop(0,"rgba(0, 0, 0, "+this.shadow.opacity+")"),n.addColorStop(.1,"rgba(0, 0, 0, 0.05)"),n.addColorStop(.3,"rgba(0, 0, 0, "+this.shadow.opacity+")"),n.addColorStop(1,"rgba(0, 0, 0, 0)")),this.ctx.clip(),this.ctx.fillStyle=n,this.ctx.fillRect(0,0,s,2*t.height),this.ctx.restore()}clear(){this.ctx.fillStyle="white",this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height)}}class p{constructor(t,e,i){this.touchPoint=null,this.swipeTimeout=250,this.onResize=()=>{this.update()},this.onMouseDown=t=>{if(this.checkTarget(t.target)){const e=this.getMousePos(t.clientX,t.clientY);this.app.startUserTouch(e),t.preventDefault()}},this.onTouchStart=t=>{if(this.checkTarget(t.target)&&t.changedTouches.length>0){const e=t.changedTouches[0],i=this.getMousePos(e.clientX,e.clientY);this.touchPoint={point:i,time:Date.now()},setTimeout(()=>{null!==this.touchPoint&&this.app.startUserTouch(i)},this.swipeTimeout),this.app.getSettings().mobileScrollSupport||t.preventDefault()}},this.onMouseUp=t=>{const e=this.getMousePos(t.clientX,t.clientY);this.app.userStop(e)},this.onMouseMove=t=>{const e=this.getMousePos(t.clientX,t.clientY);this.app.userMove(e,!1)},this.onTouchMove=t=>{if(t.changedTouches.length>0){const e=t.changedTouches[0],i=this.getMousePos(e.clientX,e.clientY);this.app.getSettings().mobileScrollSupport?(null!==this.touchPoint&&(Math.abs(this.touchPoint.point.x-i.x)>10||"read"!==this.app.getState())&&t.cancelable&&this.app.userMove(i,!0),"read"!==this.app.getState()&&t.preventDefault()):this.app.userMove(i,!0)}},this.onTouchEnd=t=>{if(t.changedTouches.length>0){const e=t.changedTouches[0],i=this.getMousePos(e.clientX,e.clientY);let s=!1;if(null!==this.touchPoint){const t=i.x-this.touchPoint.point.x,e=Math.abs(i.y-this.touchPoint.point.y);Math.abs(t)>this.swipeDistance&&e<2*this.swipeDistance&&Date.now()-this.touchPoint.time<this.swipeTimeout&&(t>0?this.app.flipPrev(this.touchPoint.point.y<this.app.getRender().getRect().height/2?"top":"bottom"):this.app.flipNext(this.touchPoint.point.y<this.app.getRender().getRect().height/2?"top":"bottom"),s=!0),this.touchPoint=null}this.app.userStop(i,s)}},this.parentElement=t,t.classList.add("stf__parent"),t.insertAdjacentHTML("afterbegin",'<div class="stf__wrapper"></div>'),this.wrapper=t.querySelector(".stf__wrapper"),this.app=e;const s=this.app.getSettings().usePortrait?1:2;t.style.minWidth=i.minWidth*s+"px",t.style.minHeight=i.minHeight+"px","fixed"===i.size&&(t.style.minWidth=i.width*s+"px",t.style.minHeight=i.height+"px"),i.autoSize&&(t.style.width="100%",t.style.maxWidth=2*i.maxWidth+"px"),t.style.display="block",window.addEventListener("resize",this.onResize,!1),this.swipeDistance=i.swipeDistance}destroy(){this.app.getSettings().useMouseEvents&&this.removeHandlers(),this.distElement.remove(),this.wrapper.remove()}getDistElement(){return this.distElement}getWrapper(){return this.wrapper}setOrientationStyle(t){this.wrapper.classList.remove("--portrait","--landscape"),"portrait"===t?(this.app.getSettings().autoSize&&(this.wrapper.style.paddingBottom=this.app.getSettings().height/this.app.getSettings().width*100+"%"),this.wrapper.classList.add("--portrait")):(this.app.getSettings().autoSize&&(this.wrapper.style.paddingBottom=this.app.getSettings().height/(2*this.app.getSettings().width)*100+"%"),this.wrapper.classList.add("--landscape")),this.update()}removeHandlers(){window.removeEventListener("resize",this.onResize),this.distElement.removeEventListener("mousedown",this.onMouseDown),this.distElement.removeEventListener("touchstart",this.onTouchStart),window.removeEventListener("mousemove",this.onMouseMove),window.removeEventListener("touchmove",this.onTouchMove),window.removeEventListener("mouseup",this.onMouseUp),window.removeEventListener("touchend",this.onTouchEnd)}setHandlers(){window.addEventListener("resize",this.onResize,!1),this.app.getSettings().useMouseEvents&&(this.distElement.addEventListener("mousedown",this.onMouseDown),this.distElement.addEventListener("touchstart",this.onTouchStart),window.addEventListener("mousemove",this.onMouseMove),window.addEventListener("touchmove",this.onTouchMove,{passive:!this.app.getSettings().mobileScrollSupport}),window.addEventListener("mouseup",this.onMouseUp),window.addEventListener("touchend",this.onTouchEnd))}getMousePos(t,e){const i=this.distElement.getBoundingClientRect();return{x:t-i.left,y:e-i.top}}checkTarget(t){return!this.app.getSettings().clickEventForward||!["a","button"].includes(t.tagName.toLowerCase())}}class c extends p{constructor(t,e,i,s){super(t,e,i),this.wrapper.insertAdjacentHTML("afterbegin",'<div class="stf__block"></div>'),this.distElement=t.querySelector(".stf__block"),this.items=s;for(const t of s)this.distElement.appendChild(t);this.setHandlers()}clear(){for(const t of this.items)this.parentElement.appendChild(t)}updateItems(t){this.removeHandlers(),this.distElement.innerHTML="";for(const e of t)this.distElement.appendChild(e);this.items=t,this.setHandlers()}update(){this.app.getRender().update()}}class u extends p{constructor(t,e,i){super(t,e,i),this.wrapper.innerHTML='<canvas class="stf__canvas"></canvas>',this.canvas=t.querySelectorAll("canvas")[0],this.distElement=this.canvas,this.resizeCanvas(),this.setHandlers()}resizeCanvas(){const t=getComputedStyle(this.canvas),e=parseInt(t.getPropertyValue("width"),10),i=parseInt(t.getPropertyValue("height"),10);this.canvas.width=e,this.canvas.height=i}getCanvas(){return this.canvas}update(){this.resizeCanvas(),this.app.getRender().update()}}class w extends l{constructor(t,e,i){super(t,e),this.outerShadow=null,this.innerShadow=null,this.hardShadow=null,this.hardInnerShadow=null,this.element=i,this.createShadows()}createShadows(){this.element.insertAdjacentHTML("beforeend",'<div class="stf__outerShadow"></div>\n             <div class="stf__innerShadow"></div>\n             <div class="stf__hardShadow"></div>\n             <div class="stf__hardInnerShadow"></div>'),this.outerShadow=this.element.querySelector(".stf__outerShadow"),this.innerShadow=this.element.querySelector(".stf__innerShadow"),this.hardShadow=this.element.querySelector(".stf__hardShadow"),this.hardInnerShadow=this.element.querySelector(".stf__hardInnerShadow")}clearShadow(){super.clearShadow(),this.outerShadow.style.cssText="display: none",this.innerShadow.style.cssText="display: none",this.hardShadow.style.cssText="display: none",this.hardInnerShadow.style.cssText="display: none"}reload(){this.element.querySelector(".stf__outerShadow")||this.createShadows()}drawHardInnerShadow(){const t=this.getRect(),e=this.shadow.progress>100?200-this.shadow.progress:this.shadow.progress;let i=(100-e)*(2.5*t.pageWidth)/100+20;i>t.pageWidth&&(i=t.pageWidth);let s=`\n            display: block;\n            z-index: ${(this.getSettings().startZIndex+5).toString(10)};\n            width: ${i}px;\n            height: ${t.height}px;\n            background: linear-gradient(to right,\n                rgba(0, 0, 0, ${this.shadow.opacity*e/100}) 5%,\n                rgba(0, 0, 0, 0) 100%);\n            left: ${t.left+t.width/2}px;\n            transform-origin: 0 0;\n        `;s+=0===this.getDirection()&&this.shadow.progress>100||1===this.getDirection()&&this.shadow.progress<=100?"transform: translate3d(0, 0, 0);":"transform: translate3d(0, 0, 0) rotateY(180deg);",this.hardInnerShadow.style.cssText=s}drawHardOuterShadow(){const t=this.getRect();let e=(100-(this.shadow.progress>100?200-this.shadow.progress:this.shadow.progress))*(2.5*t.pageWidth)/100+20;e>t.pageWidth&&(e=t.pageWidth);let i=`\n            display: block;\n            z-index: ${(this.getSettings().startZIndex+4).toString(10)};\n            width: ${e}px;\n            height: ${t.height}px;\n            background: linear-gradient(to left, rgba(0, 0, 0, ${this.shadow.opacity}) 5%, rgba(0, 0, 0, 0) 100%);\n            left: ${t.left+t.width/2}px;\n            transform-origin: 0 0;\n        `;i+=0===this.getDirection()&&this.shadow.progress>100||1===this.getDirection()&&this.shadow.progress<=100?"transform: translate3d(0, 0, 0) rotateY(180deg);":"transform: translate3d(0, 0, 0);",this.hardShadow.style.cssText=i}drawInnerShadow(){const t=this.getRect(),e=3*this.shadow.width/4,i=0===this.getDirection()?e:0,s=0===this.getDirection()?"to left":"to right",n=this.convertToGlobal(this.shadow.pos),r=this.shadow.angle+3*Math.PI/2,o=[this.pageRect.topLeft,this.pageRect.topRight,this.pageRect.bottomRight,this.pageRect.bottomLeft];let a="polygon( ";for(const t of o){let e=1===this.getDirection()?{x:-t.x+this.shadow.pos.x,y:t.y-this.shadow.pos.y}:{x:t.x-this.shadow.pos.x,y:t.y-this.shadow.pos.y};e=h.GetRotatedPoint(e,{x:i,y:100},r),a+=e.x+"px "+e.y+"px, "}a=a.slice(0,-2),a+=")";const g=`\n            display: block;\n            z-index: ${(this.getSettings().startZIndex+10).toString(10)};\n            width: ${e}px;\n            height: ${2*t.height}px;\n            background: linear-gradient(${s},\n                rgba(0, 0, 0, ${this.shadow.opacity}) 5%,\n                rgba(0, 0, 0, 0.05) 15%,\n                rgba(0, 0, 0, ${this.shadow.opacity}) 35%,\n                rgba(0, 0, 0, 0) 100%);\n            transform-origin: ${i}px 100px;\n            transform: translate3d(${n.x-i}px, ${n.y-100}px, 0) rotate(${r}rad);\n            clip-path: ${a};\n            -webkit-clip-path: ${a};\n        `;this.innerShadow.style.cssText=g}drawOuterShadow(){const t=this.getRect(),e=this.convertToGlobal({x:this.shadow.pos.x,y:this.shadow.pos.y}),i=this.shadow.angle+3*Math.PI/2,s=1===this.getDirection()?this.shadow.width:0,n=0===this.getDirection()?"to right":"to left",r=[{x:0,y:0},{x:t.pageWidth,y:0},{x:t.pageWidth,y:t.height},{x:0,y:t.height}];let o="polygon( ";for(const t of r)if(null!==t){let e=1===this.getDirection()?{x:-t.x+this.shadow.pos.x,y:t.y-this.shadow.pos.y}:{x:t.x-this.shadow.pos.x,y:t.y-this.shadow.pos.y};e=h.GetRotatedPoint(e,{x:s,y:100},i),o+=e.x+"px "+e.y+"px, "}o=o.slice(0,-2),o+=")";const a=`\n            display: block;\n            z-index: ${(this.getSettings().startZIndex+10).toString(10)};\n            width: ${this.shadow.width}px;\n            height: ${2*t.height}px;\n            background: linear-gradient(${n}, rgba(0, 0, 0, ${this.shadow.opacity}), rgba(0, 0, 0, 0));\n            transform-origin: ${s}px 100px;\n            transform: translate3d(${e.x-s}px, ${e.y-100}px, 0) rotate(${i}rad);\n            clip-path: ${o};\n            -webkit-clip-path: ${o};\n        `;this.outerShadow.style.cssText=a}drawLeftPage(){"portrait"!==this.orientation&&null!==this.leftPage&&(1===this.direction&&null!==this.flippingPage&&"hard"===this.flippingPage.getDrawingDensity()?(this.leftPage.getElement().style.zIndex=(this.getSettings().startZIndex+5).toString(10),this.leftPage.setHardDrawingAngle(180+this.flippingPage.getHardAngle()),this.leftPage.draw(this.flippingPage.getDrawingDensity())):this.leftPage.simpleDraw(0))}drawRightPage(){null!==this.rightPage&&(0===this.direction&&null!==this.flippingPage&&"hard"===this.flippingPage.getDrawingDensity()?(this.rightPage.getElement().style.zIndex=(this.getSettings().startZIndex+5).toString(10),this.rightPage.setHardDrawingAngle(180+this.flippingPage.getHardAngle()),this.rightPage.draw(this.flippingPage.getDrawingDensity())):this.rightPage.simpleDraw(1))}drawBottomPage(){if(null===this.bottomPage)return;const t=null!=this.flippingPage?this.flippingPage.getDrawingDensity():null;"portrait"===this.orientation&&1===this.direction||(this.bottomPage.getElement().style.zIndex=(this.getSettings().startZIndex+3).toString(10),this.bottomPage.draw(t))}drawFrame(){this.clear(),this.drawLeftPage(),this.drawRightPage(),this.drawBottomPage(),null!=this.flippingPage&&(this.flippingPage.getElement().style.zIndex=(this.getSettings().startZIndex+5).toString(10),this.flippingPage.draw()),null!=this.shadow&&null!==this.flippingPage&&("soft"===this.flippingPage.getDrawingDensity()?(this.drawOuterShadow(),this.drawInnerShadow()):(this.drawHardOuterShadow(),this.drawHardInnerShadow()))}clear(){for(const t of this.app.getPageCollection().getPages())t!==this.leftPage&&t!==this.rightPage&&t!==this.flippingPage&&t!==this.bottomPage&&(t.getElement().style.cssText="display: none"),t.getTemporaryCopy()!==this.flippingPage&&t.hideTemporaryCopy()}update(){super.update(),null!==this.rightPage&&this.rightPage.setOrientation(1),null!==this.leftPage&&this.leftPage.setOrientation(0)}}class x{constructor(){this._default={startPage:0,size:"fixed",width:0,height:0,minWidth:0,maxWidth:0,minHeight:0,maxHeight:0,drawShadow:!0,flippingTime:1e3,usePortrait:!0,startZIndex:0,autoSize:!0,maxShadowOpacity:1,showCover:!1,mobileScrollSupport:!0,swipeDistance:30,clickEventForward:!0,useMouseEvents:!0,showPageCorners:!0,disableFlipByClick:!1}}getSettings(t){const e=this._default;if(Object.assign(e,t),"stretch"!==e.size&&"fixed"!==e.size)throw new Error('Invalid size type. Available only "fixed" and "stretch" value');if(e.width<=0||e.height<=0)throw new Error("Invalid width or height");if(e.flippingTime<=0)throw new Error("Invalid flipping time");return"stretch"===e.size?(e.minWidth<=0&&(e.minWidth=100),e.maxWidth<e.minWidth&&(e.maxWidth=2e3),e.minHeight<=0&&(e.minHeight=100),e.maxHeight<e.minHeight&&(e.maxHeight=2e3)):(e.minWidth=e.width,e.maxWidth=e.width,e.minHeight=e.height,e.maxHeight=e.height),e}}!function(t,e){void 0===e&&(e={});var i=e.insertAt;if(t&&"undefined"!=typeof document){var s=document.head||document.getElementsByTagName("head")[0],n=document.createElement("style");n.type="text/css","top"===i&&s.firstChild?s.insertBefore(n,s.firstChild):s.appendChild(n),n.styleSheet?n.styleSheet.cssText=t:n.appendChild(document.createTextNode(t))}}(".stf__parent {\n  position: relative;\n  display: block;\n  box-sizing: border-box;\n  transform: translateZ(0);\n\n  -ms-touch-action: pan-y;\n  touch-action: pan-y;\n}\n\n.sft__wrapper {\n  position: relative;\n  \n  box-sizing: border-box;\n}\n\n.stf__parent canvas {\n  position: absolute;\n  width: 100%;\n  height: 100%;\n  left: 0;\n  top: 0;\n}\n\n.stf__block {\n  position: absolute;\n  width: 100%;\n  height: 100%;\n  box-sizing: border-box;\n  perspective: 2000px;\n}\n\n.stf__item {\n  display: none;\n  position: absolute;\n  transform-style: preserve-3d;\n}\n\n.stf__outerShadow {\n  position: absolute;\n  left: 0;\n  top: 0;\n}\n\n.stf__innerShadow {\n  position: absolute;\n  left: 0;\n  top: 0;\n}\n\n.stf__hardShadow {\n  position: absolute;\n  left: 0;\n  top: 0;\n}\n\n.stf__hardInnerShadow {\n  position: absolute;\n  left: 0;\n  top: 0;\n}");t.PageFlip=class extends class{constructor(){this.events=new Map}on(t,e){return this.events.has(t)?this.events.get(t).push(e):this.events.set(t,[e]),this}off(t){this.events.delete(t)}trigger(t,e,i=null){if(this.events.has(t))for(const s of this.events.get(t))s({data:i,object:e})}}{constructor(t,e){super(),this.isUserTouch=!1,this.isUserMove=!1,this.setting=null,this.pages=null,this.setting=(new x).getSettings(e),this.block=t}destroy(){this.ui.destroy(),this.block.remove()}update(){this.render.update(),this.pages.show()}loadFromImages(t){this.ui=new u(this.block,this,this.setting);const e=this.ui.getCanvas();this.render=new d(this,this.setting,e),this.flipController=new g(this.render,this),this.pages=new n(this,this.render,t),this.pages.load(),this.render.start(),this.pages.show(this.setting.startPage),setTimeout(()=>{this.ui.update(),this.trigger("init",this,{page:this.setting.startPage,mode:this.render.getOrientation()})},1)}loadFromHTML(t){this.ui=new c(this.block,this,this.setting,t),this.render=new w(this,this.setting,this.ui.getDistElement()),this.flipController=new g(this.render,this),this.pages=new o(this,this.render,this.ui.getDistElement(),t),this.pages.load(),this.render.start(),this.pages.show(this.setting.startPage),setTimeout(()=>{this.ui.update(),this.trigger("init",this,{page:this.setting.startPage,mode:this.render.getOrientation()})},1)}updateFromImages(t){const e=this.pages.getCurrentPageIndex();this.pages.destroy(),this.pages=new n(this,this.render,t),this.pages.load(),this.pages.show(e),this.trigger("update",this,{page:e,mode:this.render.getOrientation()})}updateFromHtml(t){const e=this.pages.getCurrentPageIndex();this.pages.destroy(),this.pages=new o(this,this.render,this.ui.getDistElement(),t),this.pages.load(),this.ui.updateItems(t),this.render.reload(),this.pages.show(e),this.trigger("update",this,{page:e,mode:this.render.getOrientation()})}clear(){this.pages.destroy(),this.ui.clear()}turnToPrevPage(){this.pages.showPrev()}turnToNextPage(){this.pages.showNext()}turnToPage(t){this.pages.show(t)}flipNext(t="top"){this.flipController.flipNext(t)}flipPrev(t="top"){this.flipController.flipPrev(t)}flip(t,e="top"){this.flipController.flipToPage(t,e)}updateState(t){this.trigger("changeState",this,t)}updatePageIndex(t){this.trigger("flip",this,t)}updateOrientation(t){this.ui.setOrientationStyle(t),this.update(),this.trigger("changeOrientation",this,t)}getPageCount(){return this.pages.getPageCount()}getCurrentPageIndex(){return this.pages.getCurrentPageIndex()}getPage(t){return this.pages.getPage(t)}getRender(){return this.render}getFlipController(){return this.flipController}getOrientation(){return this.render.getOrientation()}getBoundsRect(){return this.render.getRect()}getSettings(){return this.setting}getUI(){return this.ui}getState(){return this.flipController.getState()}getPageCollection(){return this.pages}startUserTouch(t){this.mousePosition=t,this.isUserTouch=!0,this.isUserMove=!1}userMove(t,e){this.isUserTouch||e||!this.setting.showPageCorners?this.isUserTouch&&h.GetDistanceBetweenTwoPoint(this.mousePosition,t)>5&&(this.isUserMove=!0,this.flipController.fold(t)):this.flipController.showCorner(t)}userStop(t,e=!1){this.isUserTouch&&(this.isUserTouch=!1,e||(this.isUserMove?this.flipController.stopMove():this.flipController.flip(t)))}},Object.defineProperty(t,"__esModule",{value:!0})}));
    /* eslint-enable */

    // ============================================
    // EMBEDDED CSS (for forecast content only)
    // ============================================
    var FORECAST_CSS = '\n        .forecast-page {\n            width: 100%;\n            height: 100%;\n            background: #1e2235;\n            display: flex;\n            flex-direction: column;\n        }\n        .forecast-page-content {\n            flex: 1;\n            overflow: hidden;\n            padding: 0;\n            box-sizing: border-box;\n            display: flex;\n            flex-direction: column;\n        }\n        .forecast-page-content h2 {\n            text-align: center;\n            font-size: 15px;\n            color: #fff;\n            margin: 0 0 8px 0;\n        }\n        .forecast-table {\n            width: auto;\n            margin: 0 auto;\n            border-collapse: collapse;\n            font-size: 14px;\n        }\n        .forecast-table th {\n            background: rgba(255,255,255,0.05);\n            padding: 4px 12px;\n            color: #fff;\n            border-bottom: 1px solid rgba(255,255,255,0.1);\n            font-size: 12px;\n        }\n        .forecast-table td {\n            padding: 2px 12px;\n            text-align: center;\n            color: #fff;\n            border-bottom: 1px solid rgba(255,255,255,0.03);\n        }\n        .forecast-table td.time-cell {\n            color: #fff !important;\n            font-weight: 600;\n        }\n        .forecast-table tr.current-hour {\n            background: rgba(74, 222, 128, 0.15);\n            box-shadow: 0 0 8px rgba(74, 222, 128, 0.4);\n        }\n        .fuel-green { color: #4ade80 !important; font-weight: 600; }\n        .fuel-blue { color: #60a5fa !important; font-weight: 600; }\n        .fuel-orange { color: #fbbf24 !important; font-weight: 600; }\n        .fuel-red { color: #ef4444 !important; font-weight: 600; }\n        .co2-green { color: #4ade80 !important; font-weight: 600; }\n        .co2-blue { color: #60a5fa !important; font-weight: 600; }\n        .co2-orange { color: #fbbf24 !important; font-weight: 600; }\n        .co2-red { color: #ef4444 !important; font-weight: 600; }\n        /* PageFlip styling for our modal */\n        #forecast-book .stf__block { margin: 0 auto !important; }\n        #forecast-book .stf__parent { background: #1e2235 !important; }\n        #forecast-book .stf__wrapper { background: #1e2235 !important; }\n        /* Navigation buttons */\n        .page-nav {\n            text-align: center;\n            padding: 4px 0;\n        }\n        .page-arrow {\n            display: inline-block;\n            width: 32px;\n            height: 24px;\n            line-height: 24px;\n            background: rgba(255,255,255,0.1);\n            border: 1px solid rgba(255,255,255,0.3);\n            border-radius: 4px;\n            color: #fff;\n            font-size: 14px;\n            cursor: pointer;\n        }\n    ';

    // ============================================
    // TIMEZONE CONVERSION (from api-wrapper.js)
    // ============================================

    /**
     * Get browser timezone abbreviation
     */
    function getBrowserTimezone() {
        var now = new Date();
        var offsetMinutes = -now.getTimezoneOffset();
        var offsetHours = offsetMinutes / 60;

        // Determine if DST is active
        var jan = new Date(now.getFullYear(), 0, 1);
        var jul = new Date(now.getFullYear(), 6, 1);
        var isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());

        // For Central European timezone
        if (offsetHours === 1 && !isDST) return 'CET';
        if (offsetHours === 2 && isDST) return 'CEST';
        if (offsetHours === 0) return 'UTC';
        if (offsetHours === 1) return 'GMT+1';

        // For US timezones
        if (offsetHours === -8 && !isDST) return 'PST';
        if (offsetHours === -7 && isDST) return 'PDT';
        if (offsetHours === -7 && !isDST) return 'MST';
        if (offsetHours === -6 && isDST) return 'MDT';
        if (offsetHours === -6 && !isDST) return 'CST';
        if (offsetHours === -5 && isDST) return 'CDT';
        if (offsetHours === -5 && !isDST) return 'EST';
        if (offsetHours === -4 && isDST) return 'EDT';

        // Fallback: generic UTC offset
        return 'UTC' + (offsetHours >= 0 ? '+' : '') + offsetHours;
    }

    /**
     * Get UTC offset for timezone abbreviations
     */
    function getTimezoneOffsetHours(timezone) {
        var timezoneOffsets = {
            // UTC
            'UTC': 0,

            // North America
            'HST': -10,                        // Hawaii
            'AKST': -9, 'AKDT': -8,           // Alaska
            'PST': -8, 'PDT': -7,             // Pacific
            'MST': -7, 'MDT': -6,             // Mountain
            'CST': -6, 'CDT': -5,             // Central
            'EST': -5, 'EDT': -4,             // Eastern
            'AST': -4, 'ADT': -3,             // Atlantic
            'NST': -3.5, 'NDT': -2.5,         // Newfoundland

            // South America
            'BRT': -3,                         // Brazil
            'ART': -3,                         // Argentina
            'CLT': -4, 'CLST': -3,            // Chile
            'PET': -5,                         // Peru
            'COT': -5,                         // Colombia

            // Europe
            'GMT': 0, 'BST': 1,               // UK
            'WET': 0, 'WEST': 1,              // Western Europe
            'CET': 1, 'CEST': 2,              // Central Europe
            'EET': 2, 'EEST': 3,              // Eastern Europe
            'MSK': 3,                          // Moscow

            // Africa
            'WAT': 1,                          // West Africa
            'CAT': 2,                          // Central Africa
            'EAT': 3,                          // East Africa
            'SAST': 2,                         // South Africa

            // Middle East
            'TRT': 3,                          // Turkey
            'GST': 4,                          // Gulf
            'IRST': 3.5,                       // Iran
            'IST': 5.5,                        // India

            // Asia
            'PKT': 5,                          // Pakistan
            'BST6': 6,                         // Bangladesh
            'ICT': 7,                          // Indochina
            'WIB': 7,                          // Indonesia West
            'WITA': 8,                         // Indonesia Central
            'WIT': 9,                          // Indonesia East
            'SGT': 8,                          // Singapore
            'HKT': 8,                          // Hong Kong
            'CST8': 8,                         // China
            'PHT': 8,                          // Philippines
            'JST': 9,                          // Japan
            'KST': 9,                          // Korea

            // Australia / Oceania
            'AWST': 8,                         // Australia Western
            'ACST': 9.5, 'ACDT': 10.5,        // Australia Central
            'AEST': 10, 'AEDT': 11,           // Australia Eastern
            'NZST': 12, 'NZDT': 13            // New Zealand
        };

        var normalized = timezone.toUpperCase();

        if (Object.prototype.hasOwnProperty.call(timezoneOffsets, normalized)) {
            return timezoneOffsets[normalized];
        }

        // Try parsing UTC+X format
        var match = normalized.match(/^UTC([+-]?\d+(?:\.\d+)?)$/);
        if (match) {
            return parseFloat(match[1]);
        }

        return null;
    }

    /**
     * Get data for previous day (wraps around for day 1)
     */
    function getPreviousDayData(forecastData, currentDay) {
        if (currentDay > 1) {
            return forecastData.find(function(d) { return d.day === currentDay - 1; });
        }
        // Day 1: wrap to day 31 (or last available day)
        var lastDay = Math.max.apply(Math, forecastData.map(function(d) { return d.day; }));
        return forecastData.find(function(d) { return d.day === lastDay; });
    }

    /**
     * Get data for next day (wraps based on days in given month)
     * @param {Array} forecastData - All forecast data
     * @param {number} currentDay - Current day number
     * @param {number} daysInMonth - Number of days in the month being viewed
     */
    function getNextDayData(forecastData, currentDay, daysInMonth) {
        if (currentDay < daysInMonth) {
            return forecastData.find(function(d) { return d.day === currentDay + 1; });
        }
        // Last day of month: wrap to day 1
        return forecastData.find(function(d) { return d.day === 1; });
    }

    /**
     * Determine which month a day belongs to based on current date
     * Days <= current day are current month, days > current day are previous month
     */
    function getMonthForDay(dayNumber) {
        var now = new Date();
        var currentDay = now.getDate();
        var currentMonth = now.getMonth(); // 0-indexed
        var currentYear = now.getFullYear();

        if (dayNumber <= currentDay) {
            // Current month
            return { month: currentMonth, year: currentYear };
        } else {
            // Previous month
            var prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
            var prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
            return { month: prevMonth, year: prevYear };
        }
    }

    /**
     * Get days in a specific month
     */
    function getDaysInMonth(month, year) {
        return new Date(year, month + 1, 0).getDate();
    }

    /**
     * Convert CEST forecast data to target timezone
     */
    function convertCESTToTimezone(forecastData, targetTimezone) {
        var sourceOffset = 2; // CEST is UTC+2
        var targetOffset = getTimezoneOffsetHours(targetTimezone);

        if (targetOffset === null) {
            console.error('[Forecast] Invalid timezone:', targetTimezone);
            return { success: false, data: forecastData, hoursOffset: 0 };
        }

        var hoursOffset = targetOffset - sourceOffset;

        // No conversion needed
        if (hoursOffset === 0) {
            return { success: true, data: forecastData, hoursOffset: 0 };
        }

        // Convert intervals (30-minute intervals, so hours * 2)
        var intervalOffset = Math.round(hoursOffset * 2);


        var convertedData = forecastData.map(function(dayData) {
            if (!dayData.hourly_intervals || dayData.hourly_intervals.length === 0) {
                return dayData;
            }

            var currentIntervals = dayData.hourly_intervals;
            var convertedIntervals = [];

            // Determine which month this day belongs to
            var monthInfo = getMonthForDay(dayData.day);
            var daysInMonthCount = getDaysInMonth(monthInfo.month, monthInfo.year);

            var prevDayData = getPreviousDayData(forecastData, dayData.day);
            var nextDayData = getNextDayData(forecastData, dayData.day, daysInMonthCount);

            for (var i = 0; i < 48; i++) {
                if (!currentIntervals[i]) {
                    continue;
                }

                var sourceIntervalIndex = i - intervalOffset;
                var sourceInterval;

                if (sourceIntervalIndex >= 0 && sourceIntervalIndex < 48) {
                    sourceInterval = currentIntervals[sourceIntervalIndex];
                    if (!sourceInterval) {
                        sourceInterval = currentIntervals[i];
                    }
                } else if (sourceIntervalIndex < 0) {
                    // Need data from previous day
                    if (!prevDayData || !prevDayData.hourly_intervals) {
                        sourceInterval = currentIntervals[0];
                    } else {
                        var wrappedIndex = 48 + sourceIntervalIndex;
                        sourceInterval = prevDayData.hourly_intervals[wrappedIndex];
                        if (!sourceInterval) {
                            sourceInterval = currentIntervals[0];
                        }
                    }
                } else {
                    // Need data from next day
                    if (!nextDayData || !nextDayData.hourly_intervals) {
                        sourceInterval = currentIntervals[currentIntervals.length - 1];
                    } else {
                        var wrappedIdx = sourceIntervalIndex - 48;
                        sourceInterval = nextDayData.hourly_intervals[wrappedIdx];
                        if (!sourceInterval) {
                            sourceInterval = currentIntervals[currentIntervals.length - 1];
                        }
                    }
                }

                convertedIntervals.push({
                    start_time: currentIntervals[i].start_time,
                    end_time: currentIntervals[i].end_time,
                    fuel_price_per_ton: sourceInterval.fuel_price_per_ton,
                    co2_price_per_ton: sourceInterval.co2_price_per_ton
                });
            }

            return {
                day: dayData.day,
                hourly_intervals: convertedIntervals
            };
        });

        return {
            success: true,
            data: convertedData,
            hoursOffset: hoursOffset
        };
    }

    // ============================================
    // FORECAST CALENDAR LOGIC
    // ============================================
    var pageFlip = null;
    var daysData = [];
    var browserTimezone = null;
    var forecastDataCache = { data: null, timestamp: 0, ttl: 21600000 }; // 6h TTL
    var cachedAppEl = null;
    var cachedHeaderEl = null;
    var lastRenderDataLength = 0;
    var autoPostTimer = null;

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async function getForecastData() {
        var now = Date.now();
        if (forecastDataCache.data && (now - forecastDataCache.timestamp) < forecastDataCache.ttl) {
            return forecastDataCache.data;
        }
        var response = await fetch(FORECAST_DATA_URL);
        if (!response.ok) return null;
        var data = await response.json();
        forecastDataCache.data = data;
        forecastDataCache.timestamp = Date.now();
        return data;
    }

    function getFuelClass(price) {
        if (price > 750) return 'fuel-red';
        if (price >= 650) return 'fuel-orange';
        if (price >= 500) return 'fuel-blue';
        if (price >= 1) return 'fuel-green';
        return '';
    }

    function getCo2Class(price) {
        if (price >= 20) return 'co2-red';
        if (price >= 15) return 'co2-orange';
        if (price >= 10) return 'co2-blue';
        if (price >= 1) return 'co2-green';
        return '';
    }

    function createTableHTML(intervals, dayNumber, month, year) {
        var html = '<table class="forecast-table">';
        html += '<thead><tr><th>Time</th><th>Fuel $/t</th><th>CO2 $/t</th></tr></thead>';
        html += '<tbody>';

        var now = new Date();
        var currentDay = now.getDate();
        var currentMo = now.getMonth() + 1;
        var currentYr = now.getFullYear();
        var currentHour = now.getHours();
        var currentMin = now.getMinutes();

        for (var i = 0; i < 24; i++) {
            var interval = intervals[i];
            if (!interval) {
                html += '<tr><td>&nbsp;</td><td></td><td></td></tr>';
                continue;
            }

            var time = interval.start_time.substring(0, 5);
            var timeParts = interval.start_time.split(':');
            var intHour = parseInt(timeParts[0], 10);
            var intMin = parseInt(timeParts[1], 10);

            var isCurrentHour = dayNumber === currentDay && month === currentMo && year === currentYr &&
                intHour === currentHour && intMin <= currentMin && currentMin < (intMin + 30);

            var fuelClass = getFuelClass(interval.fuel_price_per_ton);
            var co2Class = getCo2Class(interval.co2_price_per_ton);
            var currentClass = isCurrentHour ? ' current-hour' : '';

            html += '<tr class="' + currentClass + '">' +
                '<td class="time-cell">' + escapeHtml(time) + '</td>' +
                '<td class="' + fuelClass + '">' + escapeHtml(String(interval.fuel_price_per_ton)) + '</td>' +
                '<td class="' + co2Class + '">' + escapeHtml(String(interval.co2_price_per_ton)) + '</td>' +
            '</tr>';
        }

        html += '</tbody></table>';
        return html;
    }

    function destroyPageFlip() {
        if (pageFlip) {
            try {
                pageFlip.destroy();
            } catch (e) {
                console.log('[Forecast] PageFlip destroy error:', e);
            }
            pageFlip = null;
        }
        // Explicit DOM cleanup to prevent detached nodes
        var bookElement = document.getElementById('forecast-book');
        if (bookElement) {
            bookElement.innerHTML = '';
        }
    }

    function renderBook(forceRebuild) {
        var bookElement = document.getElementById('forecast-book');
        if (!bookElement) return;

        // Skip rebuild if data unchanged and PageFlip exists
        if (!forceRebuild && pageFlip && bookElement.children.length > 0 && lastRenderDataLength === daysData.length) {
            try { pageFlip.update(); } catch { /* ignore */ }
            return;
        }
        lastRenderDataLength = daysData.length;

        destroyPageFlip();

        var now = new Date();

        // Calculate page size based on available container space
        var containerWidth = bookElement.clientWidth - 5;
        var containerHeight = bookElement.clientHeight;

        // Fallback: if book element has no size, get from forecast-modal-container
        if (containerWidth < 100 || containerHeight < 100) {
            var modalContainer = document.getElementById('forecast-modal-container');
            if (modalContainer) {
                containerWidth = modalContainer.clientWidth - 5;
                containerHeight = modalContainer.clientHeight - 31; // minus header

                // Set explicit size on book element
                bookElement.style.width = containerWidth + 'px';
                bookElement.style.height = containerHeight + 'px';
            }
        }

        // Still no valid size? Abort
        if (containerWidth < 100 || containerHeight < 100) {
            console.error('[Forecast] Invalid container size');
            return;
        }

        // Each page is half the width (for 2-page spread)
        var pageWidth = Math.floor(containerWidth / 2);
        var pageHeight = containerHeight - 30;
        applyDynamicStyles(pageHeight);

        // Data is a 31-day cycle that maps to calendar days
        // Start from today and go forward, wrapping day numbers 1-31

        // Sort data by day number and create a map for quick lookup
        var dayDataMap = {};
        daysData.forEach(function(d) { dayDataMap[d.day] = d; });

        // Build pages starting from today, going forward 31 days
        var displayDate = new Date(now);

        for (var idx = 0; idx < 31; idx++) {
            var calendarDay = displayDate.getDate();
            var calendarMonth = displayDate.getMonth() + 1;
            var calendarYear = displayDate.getFullYear();

            // Get data for this day number (1-31 cycle)
            var dayData = dayDataMap[calendarDay];

            var formattedDate = String(calendarDay).padStart(2, '0') + '/' + String(calendarMonth).padStart(2, '0') + '/' + calendarYear;

            var appendPage = function(suffix, content, isLeftPage) {
                var page = document.createElement('div');
                page.className = 'forecast-page';
                var arrow = isLeftPage ? '<div class="page-nav"><span class="page-arrow page-arrow-left">&#9664;</span></div>' : '<div class="page-nav"><span class="page-arrow page-arrow-right">&#9654;</span></div>';
                page.innerHTML = '<div class="forecast-page-content"><h2>' + formattedDate + ' ' + suffix + ' ' + browserTimezone + '</h2>' + content + arrow + '</div>';
                bookElement.appendChild(page);
            };

            if (!dayData || !dayData.hourly_intervals || dayData.hourly_intervals.length === 0) {
                appendPage('', '<p style="text-align:center;color:#888;">No data</p>', true);
                var empty = document.createElement('div');
                empty.className = 'forecast-page';
                bookElement.appendChild(empty);
            } else {
                var firstHalf = dayData.hourly_intervals.slice(0, 24);
                var secondHalf = dayData.hourly_intervals.slice(24, 48);

                appendPage('AM -', createTableHTML(firstHalf, calendarDay, calendarMonth, calendarYear), true);
                appendPage('PM -', createTableHTML(secondHalf, calendarDay, calendarMonth, calendarYear), false);
            }

            // Move to next day
            displayDate.setDate(displayDate.getDate() + 1);
        }

        var PageFlipConstructor = window.St && window.St.PageFlip;
        if (!PageFlipConstructor) {
            console.error('[Forecast] PageFlip not available');
            return;
        }

        // Always start at page 0 (today)
        var startPage = 0;

        pageFlip = new PageFlipConstructor(bookElement, {
            width: pageWidth,
            height: pageHeight,
            size: 'fixed',
            flippingTime: 600,
            showCover: false,
            maxShadowOpacity: 0.5,
            mobileScrollSupport: true,
            startPage: startPage,
            clickEventForward: false,
            swipeDistance: 30,
            useMouseEvents: true,
            drawShadow: true,
            maxWidth: pageWidth,
            minWidth: pageWidth,
            maxHeight: pageHeight,
            minHeight: pageHeight
        });

        pageFlip.loadFromHTML(document.querySelectorAll('.forecast-page'));


    }

    function loadForecastData() {
        var now = Date.now();
        // Cache hit - reuse raw data
        if (forecastDataCache.data && (now - forecastDataCache.timestamp) < forecastDataCache.ttl) {
            browserTimezone = getBrowserTimezone();
            var cached = convertCESTToTimezone(forecastDataCache.data, browserTimezone);
            daysData = cached.success ? cached.data : forecastDataCache.data;
            if (!cached.success) browserTimezone = 'CEST';
            renderBook(true);
            return;
        }

        fetch(FORECAST_DATA_URL)
            .then(function(response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function(rawData) {
                forecastDataCache.data = rawData;
                forecastDataCache.timestamp = Date.now();

                browserTimezone = getBrowserTimezone();
                var conversionResult = convertCESTToTimezone(rawData, browserTimezone);
                daysData = conversionResult.success ? conversionResult.data : rawData;
                if (!conversionResult.success) browserTimezone = 'CEST';

                renderBook(true);
            })
            .catch(function(error) {
                console.error('[Forecast] Error loading data:', error);
                var bookEl = document.getElementById('forecast-book');
                if (bookEl) bookEl.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">Failed to load forecast data</p>';
            });
    }

    // Get Pinia modalStore from Vue app
    function getModalStore() {
        try {
            if (!cachedAppEl) cachedAppEl = document.getElementById('app');
            if (!cachedAppEl || !cachedAppEl.__vue_app__) return null;
            var app = cachedAppEl.__vue_app__;
            var pinia = app._context.provides.pinia || app.config.globalProperties.$pinia;
            if (!pinia || !pinia._s) return null;
            return pinia._s.get('modal');
        } catch (e) {
            console.error('[Forecast] Failed to get modalStore:', e);
            return null;
        }
    }

    var isForecastModalOpen = false;
    var modalListenerAttached = false;

    // Inject game-identical modal CSS (1:1 copy from app.css, but with dark background for forecast)
    function injectForecastModalStyles() {
        if (document.getElementById('forecast-modal-styles')) return;

        var style = document.createElement('style');
        style.id = 'forecast-modal-styles';
        style.textContent = [
            // Animations (exact copy from game)
            '@keyframes fc-fade-in{0%{opacity:0}to{opacity:1}}',
            '@keyframes fc-fade-out{0%{opacity:1}to{opacity:0}}',
            '@keyframes fc-drop-down{0%{transform:translateY(-10px)}to{transform:translateY(0)}}',
            '@keyframes fc-push-up{0%{transform:translateY(0)}to{transform:translateY(-10px)}}',

            // Modal wrapper (exact copy from game #modal-wrapper)
            '#forecast-modal-wrapper{align-items:flex-start;display:flex;height:100vh;justify-content:center;left:0;overflow:hidden;position:absolute;top:0;width:100vw;z-index:9999}',

            // Modal background (exact copy from game)
            '#forecast-modal-wrapper #forecast-modal-background{animation:fc-fade-in .15s linear forwards;background-color:rgba(0,0,0,.5);height:100%;left:0;opacity:0;position:absolute;top:0;width:100%}',
            '#forecast-modal-wrapper.hide #forecast-modal-background{animation:fc-fade-out .15s linear forwards}',

            // Modal content wrapper (exact copy from game)
            '#forecast-modal-wrapper #forecast-modal-content-wrapper{animation:fc-drop-down .15s linear forwards,fc-fade-in .15s linear forwards;height:100%;max-width:700px;opacity:0;position:relative;width:1140px;z-index:9001}',
            '#forecast-modal-wrapper.hide #forecast-modal-content-wrapper{animation:fc-push-up .15s linear forwards,fc-fade-out .15s linear forwards}',

            // Media queries for content wrapper (exact copy from game)
            '@media screen and (min-width:1200px){#forecast-modal-wrapper #forecast-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:992px) and (max-width:1199px){#forecast-modal-wrapper #forecast-modal-content-wrapper{max-width:460px}}',
            '@media screen and (min-width:769px) and (max-width:991px){#forecast-modal-wrapper #forecast-modal-content-wrapper{max-width:460px}}',
            '@media screen and (max-width:768px){#forecast-modal-wrapper #forecast-modal-content-wrapper{max-width:100%}}',

            // Modal container (exact copy from game)
            '#forecast-modal-wrapper #forecast-modal-container{background-color:#1e2235;height:100vh;overflow:hidden;position:absolute;width:100%}',

            // Modal header (exact copy from game)
            '#forecast-modal-container .modal-header{align-items:center;background:#626b90;border-radius:0;color:#fff;display:flex;height:31px;justify-content:space-between;text-align:left;width:100%;border:0!important;padding:0 .5rem!important}',

            // Header title (exact copy from game)
            '#forecast-modal-container .header-title{font-weight:700;text-transform:uppercase;width:90%}',

            // Header icon (exact copy from game)
            '#forecast-modal-container .header-icon{cursor:pointer;height:1.2rem;margin:0 .5rem}',
            '#forecast-modal-container .header-icon.closeModal{height:19px;width:19px}',

            // Modal content (exact copy from game)
            '#forecast-modal-container #forecast-modal-content{height:calc(100% - 31px);max-width:inherit;overflow:hidden;display:flex;flex-direction:column}',

            // Central container - DARK BACKGROUND for forecast readability
            '#forecast-modal-container #forecast-central-container{background-color:#1e2235;margin:0;overflow:hidden;width:100%;flex:1;padding:0}',

            // Hide class
            '#forecast-modal-wrapper.hide{pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    }

    function closeForecastModal() {
        if (!isForecastModalOpen) return;

        console.log('[Forecast] Closing forecast modal');
        isForecastModalOpen = false;

        // Clean up pageflip
        destroyPageFlip();

        // Clear rendered data but keep cache for re-use
        daysData = [];
        lastRenderDataLength = 0;

        // Hide our modal with animation, then remove DOM
        var modalWrapper = document.getElementById('forecast-modal-wrapper');
        if (modalWrapper) {
            modalWrapper.classList.add('hide');
            setTimeout(function() {
                if (!isForecastModalOpen) {
                    modalWrapper.remove();
                }
            }, 200);
        }
    }

    function setupModalWatcher() {
        if (modalListenerAttached) return;
        modalListenerAttached = true;

        // Listen for RebelShip menu clicks to close our modal
        window.addEventListener('rebelship-menu-click', function() {
            if (isForecastModalOpen) {
                console.log('[Forecast] RebelShip menu clicked, closing modal');
                closeForecastModal();
            }
        });
    }

    function ensureForecastDataLoaded() {
        if (daysData.length === 0) {
            loadForecastData();
        } else {
            renderBook();
        }
    }

    function openForecast() {
        // Close any open game modal first
        var modalStore = getModalStore();
        if (modalStore && modalStore.closeAll) {
            modalStore.closeAll();
        }

        injectForecastModalStyles();

        var existing = document.getElementById('forecast-modal-wrapper');
        if (existing) {
            // Check if content container still exists
            var contentCheck = existing.querySelector('#forecast-book');
            if (contentCheck) {
                existing.classList.remove('hide');
                isForecastModalOpen = true;
                setTimeout(ensureForecastDataLoaded, 100);
                return;
            }
            // Content missing, remove old wrapper and rebuild
            existing.remove();
        }

        // Get header height for positioning (same as game modal)
        if (!cachedHeaderEl) cachedHeaderEl = document.querySelector('header');
        var headerHeight = cachedHeaderEl ? cachedHeaderEl.offsetHeight : 89;

        // Create game-identical modal structure
        var modalWrapper = document.createElement('div');
        modalWrapper.id = 'forecast-modal-wrapper';

        var modalBackground = document.createElement('div');
        modalBackground.id = 'forecast-modal-background';
        modalBackground.onclick = function() { closeForecastModal(); };

        var modalContentWrapper = document.createElement('div');
        modalContentWrapper.id = 'forecast-modal-content-wrapper';

        var modalContainer = document.createElement('div');
        modalContainer.id = 'forecast-modal-container';
        modalContainer.className = 'font-lato';
        modalContainer.style.top = headerHeight + 'px';
        modalContainer.style.height = 'calc(100vh - ' + headerHeight + 'px)';
        modalContainer.style.maxHeight = 'calc(100vh - ' + headerHeight + 'px)';

        // Modal header
        var modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';

        var headerTitle = document.createElement('span');
        headerTitle.className = 'header-title';
        headerTitle.textContent = 'Bunker Forecast';

        var closeIcon = document.createElement('img');
        closeIcon.className = 'header-icon closeModal';
        closeIcon.src = '/images/icons/close_icon_new.svg';
        closeIcon.onclick = function() { closeForecastModal(); };
        closeIcon.onerror = function() {
            this.style.display = 'none';
            var fallback = document.createElement('span');
            fallback.textContent = 'X';
            fallback.style.cssText = 'cursor:pointer;font-weight:bold;padding:0 .5rem;color:#fff;';
            fallback.onclick = function() { closeForecastModal(); };
            this.parentNode.appendChild(fallback);
        };

        modalHeader.appendChild(headerTitle);
        modalHeader.appendChild(closeIcon);

        // Modal content
        var modalContent = document.createElement('div');
        modalContent.id = 'forecast-modal-content';

        var centralContainer = document.createElement('div');
        centralContainer.id = 'forecast-central-container';

        // Create forecast-book container
        var forecastBook = document.createElement('div');
        forecastBook.id = 'forecast-book';
        forecastBook.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';
        centralContainer.appendChild(forecastBook);

        modalContent.appendChild(centralContainer);
        modalContainer.appendChild(modalHeader);
        modalContainer.appendChild(modalContent);
        modalContentWrapper.appendChild(modalContainer);
        modalWrapper.appendChild(modalBackground);
        modalWrapper.appendChild(modalContentWrapper);
        document.body.appendChild(modalWrapper);

        isForecastModalOpen = true;

        // Wait for CSS to apply, then render
        setTimeout(ensureForecastDataLoaded, 200);
    }

    // ============================================
    // CHATBOT COMMAND INTEGRATION
    // ============================================

    var FORECAST_SCRIPT_NAME = 'ForecastCalendar';
    var FORECAST_STORE_NAME = 'chatbot';

    var forecastCmdSettings = {
        defaultTimezone: 'UTC',
        autoPostToday: {
            enabled: false,
            time: '08:00'
        },
        autoPostTomorrow: {
            enabled: false,
            time: '20:00'
        }
    };

    var autoPostLastRun = {
        today: null,
        tomorrow: null
    };

    async function loadAutoPostLastRun() {
        if (!window.RebelShipBridge) return;
        try {
            var stored = await window.RebelShipBridge.storage.get(FORECAST_SCRIPT_NAME, FORECAST_STORE_NAME, 'autoPostLastRun');
            if (stored) {
                var parsed = JSON.parse(stored);
                autoPostLastRun.today = parsed.today;
                autoPostLastRun.tomorrow = parsed.tomorrow;
            }
        } catch (e) {
            console.error('[Forecast] Failed to load autoPostLastRun:', e);
        }
    }

    async function saveAutoPostLastRun() {
        if (!window.RebelShipBridge) return;
        try {
            await window.RebelShipBridge.storage.set(FORECAST_SCRIPT_NAME, FORECAST_STORE_NAME, 'autoPostLastRun', JSON.stringify(autoPostLastRun));
        } catch (e) {
            console.error('[Forecast] Failed to save autoPostLastRun:', e);
        }
    }

    async function loadForecastCmdSettings() {
        if (!window.RebelShipBridge) return;
        try {
            var stored = await window.RebelShipBridge.storage.get(FORECAST_SCRIPT_NAME, FORECAST_STORE_NAME, 'cmdSettings');
            if (stored) {
                var parsed = JSON.parse(stored);
                if (parsed.defaultTimezone) {
                    forecastCmdSettings.defaultTimezone = parsed.defaultTimezone;
                }
                if (parsed.autoPostToday) {
                    forecastCmdSettings.autoPostToday = parsed.autoPostToday;
                }
                if (parsed.autoPostTomorrow) {
                    forecastCmdSettings.autoPostTomorrow = parsed.autoPostTomorrow;
                }
            }
        } catch (e) {
            console.error('[Forecast] Failed to load cmd settings:', e);
        }
    }

    async function saveForecastCmdSettings() {
        if (!window.RebelShipBridge) return;
        try {
            await window.RebelShipBridge.storage.set(FORECAST_SCRIPT_NAME, FORECAST_STORE_NAME, 'cmdSettings', JSON.stringify(forecastCmdSettings));
        } catch (e) {
            console.error('[Forecast] Failed to save cmd settings:', e);
        }
    }

    function renderForecastSettings() {
        var tz = forecastCmdSettings.defaultTimezone;
        var timezones = [
            // UTC
            'UTC',
            // North America (west to east)
            'HST', 'AKST', 'AKDT', 'PST', 'PDT', 'MST', 'MDT', 'CST', 'CDT', 'EST', 'EDT', 'AST', 'ADT', 'NST', 'NDT',
            // South America
            'BRT', 'ART', 'CLT', 'CLST', 'PET', 'COT',
            // Europe (west to east)
            'GMT', 'BST', 'WET', 'WEST', 'CET', 'CEST', 'EET', 'EEST', 'MSK',
            // Africa
            'WAT', 'CAT', 'EAT', 'SAST',
            // Middle East
            'TRT', 'GST', 'IRST', 'IST',
            // Asia (west to east)
            'PKT', 'BST6', 'ICT', 'WIB', 'WITA', 'WIT', 'SGT', 'HKT', 'CST8', 'PHT', 'JST', 'KST',
            // Australia / Oceania
            'AWST', 'ACST', 'ACDT', 'AEST', 'AEDT', 'NZST', 'NZDT'
        ];

        var tzOptions = '';
        for (var i = 0; i < timezones.length; i++) {
            var t = timezones[i];
            tzOptions += '<option value="' + t + '"' + (tz === t ? ' selected' : '') + '>' + t + '</option>';
        }

        var inputStyle = 'padding:4px 8px;background:#fff;border:1px solid #c0c8e0;border-radius:4px;font-size:12px;';
        var labelStyle = 'font-size:12px;color:#626b90;';
        var rowStyle = 'display:flex;align-items:center;gap:8px;margin-top:8px;';

        var todayChecked = forecastCmdSettings.autoPostToday.enabled ? ' checked' : '';
        var todayTime = forecastCmdSettings.autoPostToday.time;
        var tomorrowChecked = forecastCmdSettings.autoPostTomorrow.enabled ? ' checked' : '';
        var tomorrowTime = forecastCmdSettings.autoPostTomorrow.time;

        return '<div style="' + rowStyle + 'margin-top:4px;">' +
            '<span style="' + labelStyle + '">Default Timezone:</span>' +
            '<select id="forecast-cmd-timezone" style="' + inputStyle + '">' +
            tzOptions +
            '</select>' +
            '</div>' +
            '<div style="' + rowStyle + '">' +
            '<input type="checkbox" id="forecast-autopost-today"' + todayChecked + '>' +
            '<span style="' + labelStyle + '">Auto-post today\'s forecast at</span>' +
            '<input type="time" id="forecast-autopost-today-time" value="' + todayTime + '" style="' + inputStyle + '">' +
            '</div>' +
            '<div style="' + rowStyle + '">' +
            '<input type="checkbox" id="forecast-autopost-tomorrow"' + tomorrowChecked + '>' +
            '<span style="' + labelStyle + '">Auto-post tomorrow\'s forecast at</span>' +
            '<input type="time" id="forecast-autopost-tomorrow-time" value="' + tomorrowTime + '" style="' + inputStyle + '">' +
            '</div>';
    }

    // Event delegation for settings inputs (no inline onchange, no window globals)
    document.addEventListener('change', function(e) {
        var id = e.target.id;
        if (id === 'forecast-cmd-timezone') {
            forecastCmdSettings.defaultTimezone = e.target.value;
            saveForecastCmdSettings();
        } else if (id === 'forecast-autopost-today') {
            forecastCmdSettings.autoPostToday.enabled = e.target.checked;
            saveForecastCmdSettings();
            scheduleNextAutoPost();
        } else if (id === 'forecast-autopost-today-time') {
            forecastCmdSettings.autoPostToday.time = e.target.value;
            saveForecastCmdSettings();
            scheduleNextAutoPost();
        } else if (id === 'forecast-autopost-tomorrow') {
            forecastCmdSettings.autoPostTomorrow.enabled = e.target.checked;
            saveForecastCmdSettings();
            scheduleNextAutoPost();
        } else if (id === 'forecast-autopost-tomorrow-time') {
            forecastCmdSettings.autoPostTomorrow.time = e.target.value;
            saveForecastCmdSettings();
            scheduleNextAutoPost();
        }
    });

    function padLeft(str, len) {
        str = String(str);
        while (str.length < len) {
            str = ' ' + str;
        }
        return str;
    }

    function formatDate(day) {
        var now = new Date();
        var month = now.getMonth() + 1;
        var year = now.getFullYear();
        var dd = padLeft(day, 2).replace(/ /g, '0');
        var mm = padLeft(month, 2).replace(/ /g, '0');
        return dd + '.' + mm + '.' + year;
    }

    async function handleForecastCommand(args, userId, userName, isDm, sendResponse) {
        var targetDay = null;
        var targetTimezone = forecastCmdSettings.defaultTimezone;

        // Parse arguments: [day] [timezone]
        for (var i = 0; i < args.length; i++) {
            var arg = args[i].toUpperCase();

            // Check if it's a timezone
            if (getTimezoneOffsetHours(arg) !== null) {
                targetTimezone = arg;
                continue;
            }

            // Check if it's a day number (1-31)
            var dayNum = parseInt(args[i], 10);
            if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
                targetDay = dayNum;
                continue;
            }

            // Check for "today" or "tomorrow"
            if (arg === 'TODAY') {
                targetDay = new Date().getDate();
            } else if (arg === 'TOMORROW') {
                var tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                targetDay = tomorrow.getDate();
            }
        }

        // Default to today if no day specified
        if (targetDay === null) {
            targetDay = new Date().getDate();
        }

        // Fetch forecast data (uses 6h cache)
        try {
            var forecastData = await getForecastData();
            if (!forecastData) {
                await sendResponse('Forecast data unavailable. Try again later.', userId, isDm);
                return;
            }

            // Convert timezone
            var converted = convertCESTToTimezone(forecastData, targetTimezone);
            if (!converted.success) {
                await sendResponse('Unknown timezone: ' + targetTimezone, userId, isDm);
                return;
            }

            // Find the day
            var dayData = converted.data.find(function(d) { return d.day === targetDay; });
            if (!dayData || !dayData.hourly_intervals) {
                await sendResponse('No forecast data for day ' + targetDay, userId, isDm);
                return;
            }

            // Build response
            var lines = [];
            lines.push(userName + "'s Forecast Service");
            lines.push('');
            lines.push('Forecast ' + formatDate(targetDay) + ' (' + targetTimezone + ')');
            lines.push('');
            lines.push('TIME   FUEL  CO2');
            lines.push('-------------------');

            var intervals = dayData.hourly_intervals;
            for (var j = 0; j < intervals.length; j++) {
                var interval = intervals[j];
                if (!interval) continue;

                var time = interval.start_time.substring(0, 5);
                var fuel = padLeft(interval.fuel_price_per_ton, 5);
                var co2 = padLeft(interval.co2_price_per_ton, 4);

                lines.push(time + ' ' + fuel + ' ' + co2);
            }

            lines.push('');
            lines.push('Fair winds \uD83D\uDEA2');

            await sendResponse(lines.join('\n'), userId, isDm);
        } catch (e) {
            console.error('[Forecast] Command error:', e);
            await sendResponse('Forecast error: ' + e.message, userId, isDm);
        }
    }

    async function generateForecastMessage(targetDay, botName) {
        var targetTimezone = forecastCmdSettings.defaultTimezone;

        try {
            var forecastData = await getForecastData();
            if (!forecastData) return null;

            var converted = convertCESTToTimezone(forecastData, targetTimezone);
            if (!converted.success) {
                return null;
            }

            var dayData = converted.data.find(function(d) { return d.day === targetDay; });
            if (!dayData || !dayData.hourly_intervals) {
                return null;
            }

            var lines = [];
            lines.push(botName + "'s Forecast Service");
            lines.push('');
            lines.push('Forecast ' + formatDate(targetDay) + ' (' + targetTimezone + ')');
            lines.push('');
            lines.push('TIME   FUEL  CO2');
            lines.push('-------------------');

            var intervals = dayData.hourly_intervals;
            for (var j = 0; j < intervals.length; j++) {
                var interval = intervals[j];
                if (!interval) continue;

                var time = interval.start_time.substring(0, 5);
                var fuel = padLeft(interval.fuel_price_per_ton, 5);
                var co2 = padLeft(interval.co2_price_per_ton, 4);

                lines.push(time + ' ' + fuel + ' ' + co2);
            }

            lines.push('');
            lines.push('Fair winds \uD83D\uDEA2');

            return lines.join('\n');
        } catch (e) {
            console.error('[Forecast] Generate message error:', e);
            return null;
        }
    }

    async function checkAutoPost() {
        if (!window.RebelShipChatBot || !window.RebelShipChatBot.sendAllianceMessage) {
            return;
        }

        var now = new Date();
        var currentTime = padLeft(now.getHours(), 2).replace(/ /g, '0') + ':' + padLeft(now.getMinutes(), 2).replace(/ /g, '0');
        var todayKey = now.toDateString();

        // Check auto-post today
        if (forecastCmdSettings.autoPostToday.enabled) {
            var todayPostTime = forecastCmdSettings.autoPostToday.time;
            if (currentTime === todayPostTime && autoPostLastRun.today !== todayKey) {
                autoPostLastRun.today = todayKey;
                await saveAutoPostLastRun();
                var todayDay = now.getDate();
                var message = await generateForecastMessage(todayDay, 'Forecast Bot');
                if (message) {
                    console.log('[Forecast] Auto-posting today\'s forecast');
                    await window.RebelShipChatBot.sendAllianceMessage(message);
                }
            }
        }

        // Check auto-post tomorrow
        if (forecastCmdSettings.autoPostTomorrow.enabled) {
            var tomorrowPostTime = forecastCmdSettings.autoPostTomorrow.time;
            if (currentTime === tomorrowPostTime && autoPostLastRun.tomorrow !== todayKey) {
                autoPostLastRun.tomorrow = todayKey;
                await saveAutoPostLastRun();
                var tomorrowDate = new Date(now);
                tomorrowDate.setDate(tomorrowDate.getDate() + 1);
                var tomorrowDay = tomorrowDate.getDate();
                var tomorrowMessage = await generateForecastMessage(tomorrowDay, 'Forecast Bot');
                if (tomorrowMessage) {
                    console.log('[Forecast] Auto-posting tomorrow\'s forecast');
                    await window.RebelShipChatBot.sendAllianceMessage(tomorrowMessage);
                }
            }
        }
    }

    function calculateMsUntil(timeStr) {
        var parts = timeStr.split(':');
        var targetH = parseInt(parts[0], 10);
        var targetM = parseInt(parts[1], 10);
        var now = new Date();
        var target = new Date(now);
        target.setHours(targetH, targetM, 0, 0);
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        return target.getTime() - now.getTime();
    }

    function scheduleNextAutoPost() {
        if (autoPostTimer) {
            clearTimeout(autoPostTimer);
            autoPostTimer = null;
        }

        var delays = [];
        if (forecastCmdSettings.autoPostToday.enabled) {
            delays.push(calculateMsUntil(forecastCmdSettings.autoPostToday.time));
        }
        if (forecastCmdSettings.autoPostTomorrow.enabled) {
            delays.push(calculateMsUntil(forecastCmdSettings.autoPostTomorrow.time));
        }

        if (delays.length === 0) return;

        var nextDelay = Math.min.apply(Math, delays);
        autoPostTimer = setTimeout(function() {
            checkAutoPost();
            scheduleNextAutoPost();
        }, nextDelay + 1000); // +1s buffer to ensure past target minute
    }

    // Background job for Android BackgroundScriptService
    function registerBackgroundJob() {
        window.rebelshipBackgroundJobs = window.rebelshipBackgroundJobs || [];

        var alreadyRegistered = window.rebelshipBackgroundJobs.some(function(job) {
            return job.name === 'ForecastAutoPost';
        });
        if (alreadyRegistered) {
            return;
        }

        window.rebelshipBackgroundJobs.push({
            name: 'ForecastAutoPost',
            run: async function() {
                if (!window.RebelShipChatBot || !window.RebelShipChatBot.sendAllianceMessage) {
                    return { skipped: true, reason: 'ChatBot not available' };
                }

                await loadForecastCmdSettings();
                await loadAutoPostLastRun();

                var now = new Date();
                var currentTime = padLeft(now.getHours(), 2).replace(/ /g, '0') + ':' + padLeft(now.getMinutes(), 2).replace(/ /g, '0');
                var todayKey = now.toDateString();
                var results = { todayPosted: false, tomorrowPosted: false };

                // Check auto-post today
                if (forecastCmdSettings.autoPostToday.enabled) {
                    var todayPostTime = forecastCmdSettings.autoPostToday.time;
                    if (currentTime === todayPostTime && autoPostLastRun.today !== todayKey) {
                        autoPostLastRun.today = todayKey;
                        await saveAutoPostLastRun();
                        var todayDay = now.getDate();
                        var message = await generateForecastMessage(todayDay, 'Forecast Bot');
                        if (message) {
                            await window.RebelShipChatBot.sendAllianceMessage(message);
                            results.todayPosted = true;
                        }
                    }
                }

                // Check auto-post tomorrow
                if (forecastCmdSettings.autoPostTomorrow.enabled) {
                    var tomorrowPostTime = forecastCmdSettings.autoPostTomorrow.time;
                    if (currentTime === tomorrowPostTime && autoPostLastRun.tomorrow !== todayKey) {
                        autoPostLastRun.tomorrow = todayKey;
                        await saveAutoPostLastRun();
                        var tomorrowDate = new Date(now);
                        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
                        var tomorrowDay = tomorrowDate.getDate();
                        var tomorrowMessage = await generateForecastMessage(tomorrowDay, 'Forecast Bot');
                        if (tomorrowMessage) {
                            await window.RebelShipChatBot.sendAllianceMessage(tomorrowMessage);
                            results.tomorrowPosted = true;
                        }
                    }
                }

                return results;
            }
        });
    }

    async function registerChatBotCommands() {
        if (!window.RebelShipChatBot || !window.RebelShipChatBot.registerCommand) {
            return;
        }

        // Load saved settings and auto-post state
        await loadForecastCmdSettings();
        await loadAutoPostLastRun();

        window.RebelShipChatBot.registerCommand('forecast', handleForecastCommand, {
            minRole: 'all',
            description: 'Fuel/CO2 price forecast',
            usage: '!forecast [day] [timezone]\n' +
                   '!forecast - Today\'s forecast\n' +
                   '!forecast 25 - Day 25 forecast\n' +
                   '!forecast PST - Today in PST timezone\n' +
                   '!forecast tomorrow EST - Tomorrow in EST\n' +
                   'Timezones: CEST, CET, UTC, EST, EDT, CST, CDT, MST, MDT, PST, PDT',
            renderSettings: renderForecastSettings
        });

        window.RebelShipChatBot.registerCommand('fc', handleForecastCommand, {
            minRole: 'all',
            description: 'Shortcut for !forecast',
            usage: 'Same as !forecast - see !help forecast'
        });

        // Schedule next auto-post (dynamic setTimeout)
        scheduleNextAutoPost();

        // Register background job for Android
        registerBackgroundJob();
    }

    function init() {
        // Inject CSS
        var style = document.createElement('style');
        style.textContent = FORECAST_CSS;
        document.head.appendChild(style);

        // Setup modal watcher (same pattern as alliance-search)
        setupModalWatcher();

        // Use global addMenuItem from RebelShipMenu
        addMenuItem('Bunker Forecast', openForecast, 18);

        // Register ChatBot commands (with delay to ensure ChatBot is loaded)
        setTimeout(registerChatBotCommands, 1000);
    }

    if (!window.__rebelshipHeadless) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    } else {
        registerBackgroundJob();
    }
})();
