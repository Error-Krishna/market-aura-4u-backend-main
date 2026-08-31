const contentRouter=require("express").Router();
const auth=require("../../../utils/auth");
const { publishContent}=require("../../../controllers/content/publishContent");
const {generateContent}=require("../../../controllers/content/generateContent");
const {getGeneratedContent}=require("../../../controllers/content/getGeneratedContent");
const isOnboarded=require("../../../utils/isOnboarded");

contentRouter.post('/generate',auth,isOnboarded,generateContent);
contentRouter.post('/publish',auth,isOnboarded,publishContent);
contentRouter.get('/history',auth,isOnboarded,getGeneratedContent);

module.exports=contentRouter;

