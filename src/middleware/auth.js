const jwt = require("jsonwebtoken");
const userModel = require("../models/User.js");

const verify = async (req, res, next) => {
    try {
        // 1. Try to get token from Header OR Cookie
        let token = req.cookies.token; 
        
        if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
            token = req.headers.authorization.split(" ")[1];
        }
          console.log(token);
        if (!token) {
            return res.status(401).json({ message: "Access denied. No token provided." });
        }
        

        // 2. Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECREAT_KEY);
        
        // 3. Attach user to request
        const user = await userModel.findOne({ email: decoded.email });
        if (!user) {
            return res.status(401).send("User not found");
        }

        req.user = user;
        next();
    } catch (err) {
        console.error("Auth Error:", err.message);
        return res.status(401).json({ message: "Invalid or expired token" });
    }
};

module.exports = verify;