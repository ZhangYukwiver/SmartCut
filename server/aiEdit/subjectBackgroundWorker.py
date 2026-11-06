"""Recover observed background across the original clip; never consume a rendered effect."""
import importlib.util
import json
from pathlib import Path
import sys
import warnings

import cv2
import numpy as np

# Reuse the existing source-clock/rotation contract without changing camera tracking.
spec = importlib.util.spec_from_file_location("smartcut_camera", Path(__file__).with_name("cameraTrackWorker.py"))
camera = importlib.util.module_from_spec(spec)
spec.loader.exec_module(camera)


def match_boundary(observed, copied, unknown):
    """Harmonically extend observed colour differences into the unknown region.

    Fix the Dirichlet values at every genuinely known pixel. Restoring known pixels
    after a wider Poisson clone creates a second seam at the original hole boundary.
    A coarse-to-fine solve also handles holes that touch the frame edge.
    """
    h,w=unknown.shape; known=(unknown==0).astype(np.float32)
    difference=(observed.astype(np.float32)-copied.astype(np.float32))*known[:,:,None]
    solution=None
    for divisor in [32,16,8,4,2,1]:
        size=(max(2,w//divisor),max(2,h//divisor))
        weights=cv2.resize(known,size,interpolation=cv2.INTER_AREA)
        fixed=cv2.resize(difference,size,interpolation=cv2.INTER_AREA)/np.maximum(weights[:,:,None],1e-6)
        hole=weights<.01
        solution=np.zeros_like(fixed) if solution is None else cv2.resize(solution,size,interpolation=cv2.INTER_LINEAR)
        solution[~hole]=fixed[~hole]
        for iteration in range(400):
            smoothed=cv2.blur(solution,(3,3),borderType=cv2.BORDER_REFLECT)
            error=np.max(np.abs(smoothed[hole]-solution[hole])) if np.any(hole) else 0
            solution[hole]=smoothed[hole]
            if iteration>20 and error<.015:break
    result=observed.copy();hole=unknown>0
    result[hole]=np.clip(copied.astype(np.float32)+solution,0,255).astype(np.uint8)[hole]
    return result


def continue_structure(clean, unknown):
    """Extend a measured pair of dark parallel boundaries through an unseen region.

    This is inferred texture placement, not recovered observation. If the scene has no
    well-supported straight band or no clean source translation, leave it to inpainting.
    """
    h,w=unknown.shape; gray=cv2.cvtColor(clean,cv2.COLOR_BGR2GRAY)
    excluded=cv2.dilate(unknown,np.ones((19,19),np.uint8))>0
    found=cv2.createLineSegmentDetector().detect(gray)[0]
    if found is None:return None,None
    lines=[]
    for x1,y1,x2,y2 in found.reshape(-1,4):
        length=np.hypot(x2-x1,y2-y1)
        if length<100 or abs(x2-x1)<length*.75:continue
        pts=np.rint(np.linspace([x1,y1],[x2,y2],30)).astype(int)
        pts=np.clip(pts,[0,0],[w-1,h-1])
        if np.mean(excluded[pts[:,1],pts[:,0]])>.1:continue
        m=(y2-y1)/(x2-x1);b=y1-m*x1
        lines.append((float(m),float(b),float(length),min(x1,x2),max(x1,x2)))
    choices=[]
    for i,(m,b,length,left,right) in enumerate(lines):
        for M,B,L,lo,hi in lines[i+1:]:
            separation=abs(B-b)/np.sqrt(1+m*m);overlap=min(right,hi)-max(left,lo)
            if abs(m-M)>.05 or not 8<separation<70 or overlap<90:continue
            slope=(m+M)/2;mid=(b+B)/2;xs=np.linspace(max(left,lo)+5,min(right,hi)-5,30)
            def sample(offset):
                ys=np.rint(slope*xs+mid+offset).astype(int);xx=np.rint(xs).astype(int)
                valid=(ys>=0)&(ys<h)&(xx>=0)&(xx<w)
                return float(np.median(gray[ys[valid],xx[valid]])) if np.count_nonzero(valid)>20 else 0
            contrast=min(sample(separation*1.2),sample(-separation*1.2))-sample(0)
            if contrast>22:choices.append((overlap*overlap*contrast,slope,mid,separation,contrast))
    if not choices:
        # Perspective or textured flooring may fragment the second boundary. A long
        # measured edge can still establish a band if both sides of its dark trough
        # are visibly brighter in the known pixels.
        for slope,intercept,length,left,right in lines:
            if length<150:continue
            xs=np.linspace(left+12,right-12,50);xx=np.rint(xs).astype(int)
            profile=[]
            for offset in range(-35,46):
                yy=np.rint(slope*xs+intercept+offset).astype(int);valid=(yy>=0)&(yy<h)&(xx>=0)&(xx<w)
                ids=np.flatnonzero(valid);ids=ids[~excluded[yy[ids],xx[ids]]]
                profile.append(float(np.median(gray[yy[ids],xx[ids]])) if len(ids)>25 else np.nan)
            if not np.all(np.isfinite(profile)):continue
            trough=int(np.argmin(profile[25:65]))+25
            contrast=min(np.median(profile[:10]),np.median(profile[-10:]))-profile[trough]
            if contrast>22:choices.append((length*length*contrast,slope,intercept+trough-35,20.0,float(contrast)))
    if not choices:return None,None
    _,slope,mid,separation,contrast=max(choices)
    yy,xx=np.indices((h,w),dtype=np.float32);hole=unknown>0
    for distance in range(32,w,16):
        for shift in [distance,-distance]:
            mx=xx+shift;my=yy+slope*shift
            valid=cv2.remap((255-unknown),mx,my,cv2.INTER_NEAREST,borderMode=cv2.BORDER_CONSTANT,borderValue=0)>250
            if np.mean(valid[hole])<.999:continue
            copied=cv2.remap(clean,mx,my,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REFLECT)
            result=match_boundary(clean,copied,unknown)
            return result,{"method":"observed-parallel-band-texture-continuation","boundary":"harmonic-known-pixel-constraints","slope":slope,"intercept":mid,"bandWidth":separation,"contrast":contrast,"translation":shift,"observed":False}
    return None,None


def reconstruct(video, folder, output, reference_time):
    folder, output = Path(folder), Path(output)
    analysis = json.loads((folder / "analysis.json").read_text())
    decoded = list(camera.frames_in_clip(video, analysis["start"], analysis["length"]))
    rows = analysis["frames"]
    if len(decoded) != len(rows):
        raise ValueError("背景与主体分析帧数不一致，不能错帧回填")
    scale = min(1, 960 / max(analysis["size"]))
    w, h = [round(n * scale) for n in analysis["size"]]
    images, masks, grays = [], [], []
    for (time, frame), row in zip(decoded, rows):
        if abs(time - row["time"]) > .022:
            raise ValueError("背景与主体时间戳不一致")
        raw = frame.to_ndarray(format="bgr24")
        raw = np.ascontiguousarray(np.rot90(raw, round(frame.rotation / 90) % 4))
        image = cv2.resize(raw, (w, h), interpolation=cv2.INTER_AREA)
        mask = np.zeros((h, w), np.uint8)
        if not row.get("matte"):
            raise ValueError("存在没有主体遮罩的帧，不能将它当作干净背景")
        alpha = cv2.imread(str(folder / row["matte"]), cv2.IMREAD_UNCHANGED)[:, :, 3]
        x, y, rw, rh = row["rect"]
        x, y, rw, rh = round(x*w), round(y*h), max(1, round(rw*w)), max(1, round(rh*h))
        patch = cv2.resize(alpha, (rw, rh))
        mask[y:min(h,y+rh), x:min(w,x+rw)] = patch[:min(rh,h-y), :min(rw,w-x)]
        mask = cv2.dilate((mask > 16).astype(np.uint8)*255, np.ones((15,15),np.uint8))
        images.append(image); masks.append(mask); grays.append(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    ref = min(range(len(rows)), key=lambda i:abs(rows[i]["time"] - reference_time * analysis["speed"]))
    points = camera.features(grays[ref], 255-masks[ref])
    if len(points) < 40:
        raise ValueError("背景静态特征不足，不能可靠配准")
    transforms, errors, inliers = [], [], []
    for i, gray in enumerate(grays):
        if i == ref:
            transforms.append(np.eye(2,3));errors.append(0.0);inliers.append(len(points));continue
        flowed, valid = camera.optical_flow(grays[ref],gray,points)
        loc = np.clip(np.rint(flowed).astype(int),[0,0],[w-1,h-1])
        valid &= masks[i][loc[:,1],loc[:,0]] == 0
        a,b=flowed[valid],points[valid]
        if len(a)<30:
            raise ValueError(f"第{i}帧背景配准特征不足")
        train=np.arange(len(a))%4!=0
        matrix,good=cv2.estimateAffinePartial2D(a[train],b[train],method=cv2.RANSAC,ransacReprojThreshold=2.0,maxIters=3000)
        if matrix is None or np.count_nonzero(good)<24:
            raise ValueError(f"第{i}帧背景配准不可信")
        residual=np.linalg.norm(cv2.transform(a[~train,None,:],matrix)[:,0]-b[~train],axis=1)
        error=float(np.median(residual))
        if error>2.5:
            raise ValueError(f"第{i}帧背景留出点误差{error:.2f}px超过2.5px")
        transforms.append(matrix);errors.append(error);inliers.append(int(np.count_nonzero(good)))
    samples=np.unique(np.rint(np.linspace(0,len(rows)-1,min(36,len(rows)))).astype(int))
    stack=[]
    for i in samples:
        matrix=transforms[i]
        visible=cv2.warpAffine(255-masks[i],matrix,(w,h),flags=cv2.INTER_NEAREST,borderValue=0)>250
        warped=cv2.warpAffine(images[i],matrix,(w,h)).astype(np.float32)
        warped[~visible]=np.nan
        stack.append(warped)
    stack=np.stack(stack)
    counts=np.sum(np.isfinite(stack[:,:,:,0]),axis=0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore",RuntimeWarning)
        clean=np.nanmedian(stack,axis=0)
    unknown=(counts<2).astype(np.uint8)*255
    clean=np.nan_to_num(clean).clip(0,255).astype(np.uint8)
    # Known observations remain intact. Only the explicit unknown mask may be inferred later.
    output.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(output/"observed.png"),clean)
    coverage=np.minimum(counts,8).astype(np.uint8)*31
    cv2.imwrite(str(output/"coverage.png"),coverage)
    rgba=np.zeros((h,w,4),np.uint8);rgba[:,:,3]=unknown
    cv2.imwrite(str(output/"unknown.png"),rgba)
    structured,structure=continue_structure(clean,unknown)
    if structured is not None:cv2.imwrite(str(output/"structural.png"),structured)
    frames=[]
    for row,matrix,error,n in zip(rows,transforms,errors,inliers):
        inverse=cv2.invertAffineTransform(matrix)
        frames.append({"time":row["time"]/analysis["speed"],"matrix":inverse.flatten().tolist(),"error":error,"inliers":n})
    result={"size":[w,h],"frames":frames,"duration":analysis["duration"],"referenceTime":rows[ref]["time"]/analysis["speed"],
            "observedFraction":float(np.mean(counts>=2)),"inferredFraction":float(np.mean(counts<2)),
            "alignmentMedianP95":float(np.percentile(errors,95)),"sourceFrames":len(rows),"sampledFrames":len(samples),
            "structure":structure,"status":"pass","validationScope":"registration and source provenance; inferred pixels still require composite visual review"}
    (output/"alignment.json").write_text(json.dumps(result,separators=(",",":"),allow_nan=False))
    return result


if __name__ == "__main__":
    r=reconstruct(*sys.argv[1:4],float(sys.argv[4]))
    print(json.dumps({k:v for k,v in r.items() if k!="frames"},separators=(",",":")))
