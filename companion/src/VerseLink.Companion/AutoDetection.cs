using System.Drawing;
using System.Text.RegularExpressions;
namespace VerseLink.Companion;
public sealed record AutoDetectedRegions(RegionOfInterest? Location,RegionOfInterest? WorkOrder,double LocationConfidence,double WorkOrderConfidence);
public static class AutomaticRegionDetector{
 static string C(string s)=>Regex.Replace(s.ToUpperInvariant(),@"[^A-Z0-9]","");
 public static AutoDetectedRegions Detect(OcrResult ocr){var w=ocr.Words.ToList();var h=w.Select(x=>x.Height).DefaultIfEmpty(12).Average();var l=w.FirstOrDefault(x=>C(x.Text) is "CHECKMATE" or "EVERUSHARBOR" or "LORVILLE");var a=w.Where(x=>C(x.Text) is "COMPLETED" or "MATERIAL" or "MATERIALS" or "QUALITY" or "QUALITV" or "YIELD" or "YIELO").ToList();RegionOfInterest? work=null;if(a.Count>=3){var x=a.Min(z=>z.X)-h*3;var y=a.Min(z=>z.Y)-h*3;var r=a.Max(z=>z.X+z.Width)+h*8;var b=a.Max(z=>z.Y+z.Height)+h*15;work=RegionOfInterest.FromPixels(RegionType.WorkOrder,Rectangle.Intersect(new Rectangle(0,0,ocr.ImageWidth,ocr.ImageHeight),Rectangle.FromLTRB((int)Math.Max(0,x),(int)Math.Max(0,y),(int)Math.Min(ocr.ImageWidth,r),(int)Math.Min(ocr.ImageHeight,b))),ocr.ImageWidth,ocr.ImageHeight);}RegionOfInterest? location=null;if(l!=null){location=RegionOfInterest.FromPixels(RegionType.Location,Rectangle.FromLTRB((int)Math.Max(0,l.X-h*3),(int)Math.Max(0,l.Y-h*3),(int)Math.Min(ocr.ImageWidth,l.X+l.Width+h*3),(int)Math.Min(ocr.ImageHeight,l.Y+l.Height+h*3)),ocr.ImageWidth,ocr.ImageHeight);}return new(location,work,l==null?0:1,Math.Min(1,a.Count/4.0));}
}
